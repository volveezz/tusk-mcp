import { Client } from 'ssh2'
import net from 'net'
import { readFile } from 'fs/promises'
import type { TunnelOptions, Tunnel } from './types.js'

/**
 * Creates an SSH tunnel that forwards local TCP connections to a remote
 * host:port through an SSH bastion. Returns the local endpoint to connect to
 * and a close() handle for cleanup.
 */
export async function createTunnel(options: TunnelOptions): Promise<Tunnel> {
  const ssh = new Client()

  const privateKey = options.sshKey
    ? await readFile(options.sshKey, 'utf-8')
    : undefined

  await new Promise<void>((resolve, reject) => {
    ssh.on('ready', resolve)
    ssh.on('error', reject)
    ssh.connect({
      host: options.sshHost,
      port: options.sshPort,
      username: options.sshUser,
      privateKey,
      password: options.sshPassword,
    })
  })

  const server = net.createServer((socket) => {
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const localPort = (server.address() as net.AddressInfo).port

  return {
    localHost: '127.0.0.1',
    localPort,
    close: async () => {
      server.close()
      ssh.end()
    },
  }
}
