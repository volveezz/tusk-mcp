import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import { readFile } from 'fs/promises'
import type { TunnelOptions, Tunnel } from './types.js'

export async function createTunnel(options: TunnelOptions): Promise<Tunnel> {
  // ssh2 costs ~16 MB RSS and ~5 ms at startup; measured 2026-11 on a bun --compile build
  const { Client } = await import('ssh2')
  const ssh = new Client()

  const privateKey = options.sshKey
    ? await readFile(options.sshKey, 'utf-8')
    : undefined

  await new Promise<void>((resolve, reject) => {
    ssh.on('ready', () => {
      // ssh2 leaves Nagle on; under node every pgwire round trip then waits on delayed ACK, ~180 ms p50 observed 2026-11
      ssh.setNoDelay(true)
      resolve()
    })
    ssh.on('error', reject)
    ssh.connect({
      host: options.sshHost,
      port: options.sshPort,
      username: options.sshUser,
      privateKey,
      password: options.sshPassword,
      readyTimeout: 10_000,
    })
  })

  const listener = await listenLoopback((socket) => {
    ssh.forwardOut(
      '127.0.0.1', 0,
      options.targetHost, options.targetPort,
      (err, stream) => {
        if (err) { socket.end(); return }
        socket.pipe(stream).pipe(socket)
        socket.on('error', () => stream.end())
        stream.on('error', () => socket.end())
      },
    )
  })

  return {
    localHost: listener.localHost,
    localPort: listener.localPort,
    close: async () => {
      listener.close()
      ssh.end()
    },
  }
}

/** A hop lives as long as one connection; the first one is spawned up front to prove the command works. */
interface Hop {
  child: ChildProcess
  stderr: string
  /** True once the database has answered through this hop, which is what separates a working command from a broken one. */
  carried: boolean
}

// postgres.js reconnects without backoff whenever a connection drops, so the
// tunnel stops listening once this many consecutive hops carry nothing, and
// the target is rebuilt from scratch on the next tool call
const FAILURE_THRESHOLD = 3
const PROBE_MS = 1_500
const SIGKILL_DELAY_MS = 2_000

/**
 * One child process per connection, its stdin/stdout spliced to the socket.
 * The command runs through a shell, so it is written exactly as it would be
 * typed, and a command that exits during the probe rejects with its stderr,
 * which is where ssh, docker, and kubectl explain themselves.
 */
export async function createProxyCommandTunnel(command: string): Promise<Tunnel> {
  const children = new Set<ChildProcess>()
  let consecutiveFailures = 0
  let closing = false
  let declareBroken!: (err: Error) => void
  const broken = new Promise<Error>((resolve) => { declareBroken = resolve })

  const probe = spawnHop(command)
  children.add(probe.child)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, PROBE_MS)
    probe.child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`proxyCommand failed to start: ${err.message}`))
    })
    probe.child.once('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(probe.child)
      reject(new Error(`proxyCommand ${describeExit(code, signal)}${detail(probe)}`))
    })
  })
  probe.child.removeAllListeners('close')
  probe.child.removeAllListeners('error')

  // the probe child never wrote a byte, so the first connection adopts it
  let warm: Hop | undefined = probe

  const listener = await listenLoopback((socket) => {
    let hop = warm
    warm = undefined
    if (!hop || hop.child.exitCode !== null) {
      hop = spawnHop(command)
      children.add(hop.child)
    }
    adopt(hop, socket)
  })

  function adopt(hop: Hop, socket: net.Socket): void {
    socket.pipe(hop.child.stdin!)
    hop.child.stdout!.pipe(socket)
    hop.child.stdout!.on('data', () => { hop.carried = true })

    socket.on('error', () => killTree(hop.child))
    socket.on('close', () => killTree(hop.child))

    hop.child.on('error', (err) => {
      console.error(`tusk-mcp: proxyCommand failed to start: ${err.message}`)
      socket.destroy()
    })
    hop.child.on('close', (code, signal) => {
      children.delete(hop.child)
      socket.end()
      if (closing) return

      if (hop.carried) {
        consecutiveFailures = 0
        return
      }
      const reason = `proxyCommand ${describeExit(code, signal)}${detail(hop)}`
      console.error(`tusk-mcp: ${reason}`)
      if (++consecutiveFailures >= FAILURE_THRESHOLD) {
        listener.close()
        declareBroken(new Error(`${reason} on ${FAILURE_THRESHOLD} consecutive hops`))
      }
    })
  }

  return {
    localHost: listener.localHost,
    localPort: listener.localPort,
    broken,
    close: async () => {
      closing = true
      listener.close()
      const exits = [...children].map(child => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('close', () => resolve())
      }))
      for (const child of children) killTree(child)
      await Promise.all(exits)
      children.clear()
    },
  }
}

function spawnHop(command: string): Hop {
  // detached puts the shell and whatever it spawns in one process group, so a
  // piped command is killed whole rather than orphaning its right-hand side
  const child = spawn(command, { shell: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const hop: Hop = { child, stderr: '', carried: false }

  child.stderr?.on('data', (chunk: Buffer) => {
    hop.stderr = (hop.stderr + chunk.toString()).slice(-2000)
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {})

  return hop
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-child.pid!, sig) } catch { child.kill(sig) }
  }
  signal('SIGTERM')
  const escalation = setTimeout(() => signal('SIGKILL'), SIGKILL_DELAY_MS)
  escalation.unref()
  child.once('close', () => clearTimeout(escalation))
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `killed by ${signal}` : `exited ${code}`
}

function detail(hop: Hop): string {
  const trimmed = hop.stderr.trim()
  return trimmed ? `: ${trimmed}` : ''
}

interface LocalListener {
  localHost: string
  localPort: number
  close: () => void
}

async function listenLoopback(onConnection: (socket: net.Socket) => void): Promise<LocalListener> {
  const server = net.createServer(onConnection)
  // headroom over the postgres.js pool; anything beyond it is a local process
  // that has no business on this port
  server.maxConnections = 16
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    localHost: '127.0.0.1',
    localPort: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
  }
}
