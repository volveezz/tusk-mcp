import { describe, expect, test } from 'bun:test'
import net from 'net'
import { createProxyCommandTunnel } from './tunnel.js'

/** Writes on an open connection, the way a pg client holds its session, and reads the reply back. */
function echo(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    socket.on('data', chunk => { socket.destroy(); resolve(chunk.toString()) })
    socket.on('close', () => resolve(''))
    socket.on('error', reject)
  })
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('createProxyCommandTunnel', () => {
  test('splices the socket to the command in both directions', async () => {
    const tunnel = await createProxyCommandTunnel('cat')
    try {
      expect(await echo(tunnel.localPort, 'select 1')).toBe('select 1')
      expect(await echo(tunnel.localPort, 'select 2')).toBe('select 2')
    } finally {
      await tunnel.close()
    }
  })

  test('a command that exits fails the connect instead of looping', async () => {
    await expect(createProxyCommandTunnel('echo boom >&2; exit 7'))
      .rejects.toThrow('proxyCommand exited 7: boom')
  })

  test('close kills the whole process group behind the shell', async () => {
    const marker = `tusk-tunnel-test-${process.pid}`
    // the forked subshell inherits the marker in its argv, so pgrep sees a leak
    const tunnel = await createProxyCommandTunnel(`( sleep 300 ) & cat # ${marker}`)
    await echo(tunnel.localPort, 'x')
    await tunnel.close()

    const survivors = await Bun.$`pgrep -f ${marker}`.quiet().nothrow()
    const pids = survivors.stdout.toString().trim().split('\n').filter(Boolean).map(Number)
    expect(pids.filter(alive)).toEqual([])
  })
})
