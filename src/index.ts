#!/usr/bin/env node
import { parseArgs } from 'util'
import { readFile } from 'fs/promises'
import { execSync } from 'child_process'
import { createPostgresClient } from './client.js'
import { createTunnel } from './tunnel.js'
import { TuskMcpServer } from './server.js'
import { parseConnectionString } from './utils.js'
import type { ConnectionFlags, PostgresConnectionOptions, Tunnel } from './types.js'

async function resolvePassword(flags: ConnectionFlags): Promise<string | undefined> {
  if (flags.password) return flags.password

  if (flags['password-file']) {
    return (await readFile(flags['password-file'], 'utf-8')).trim()
  }

  if (flags['password-cmd']) {
    try {
      return execSync(flags['password-cmd'], { encoding: 'utf-8' }).trim()
    } catch {
      throw new Error(`password-cmd failed`)
    }
  }

  return process.env.PGPASSWORD
}

async function buildSslConfig(flags: ConnectionFlags) {
  if (!flags.ssl && !flags['ssl-ca'] && !flags['ssl-cert'] && !flags['ssl-key']) {
    return false
  }

  if (!flags['ssl-ca'] && !flags['ssl-cert'] && !flags['ssl-key']) {
    return { rejectUnauthorized: false }
  }

  const config: Record<string, unknown> = { rejectUnauthorized: true }
  if (flags['ssl-ca']) config.ca = await readFile(flags['ssl-ca'], 'utf-8')
  if (flags['ssl-cert']) config.cert = await readFile(flags['ssl-cert'], 'utf-8')
  if (flags['ssl-key']) config.key = await readFile(flags['ssl-key'], 'utf-8')
  return config
}

async function main() {
  if (process.argv.includes('setup')) {
    const { startSetup } = await import('./setup.js')
    await startSetup()
    return
  }

  const { values: flags } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      'password-file': { type: 'string' },
      'password-cmd': { type: 'string' },
      database: { type: 'string' },
      'connection-string': { type: 'string' },
      ssl: { type: 'boolean', default: false },
      'ssl-ca': { type: 'string' },
      'ssl-cert': { type: 'string' },
      'ssl-key': { type: 'string' },
      'ssh-host': { type: 'string' },
      'ssh-port': { type: 'string' },
      'ssh-user': { type: 'string' },
      'ssh-key': { type: 'string' },
      'ssh-password': { type: 'string' },
      'structure-only': { type: 'boolean', default: false },
    },
    strict: true,
  })

  const parsedFlags: ConnectionFlags = {
    ...flags,
    port: flags.port ? parseInt(flags.port) : undefined,
    'ssh-port': flags['ssh-port'] ? parseInt(flags['ssh-port']) : undefined,
  }

  let base: PostgresConnectionOptions = {
    host: process.env.PGHOST ?? 'localhost',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  }

  if (process.env.DATABASE_URL) {
    base = { ...base, ...parseConnectionString(process.env.DATABASE_URL) }
  }

  if (parsedFlags['connection-string']) {
    base = { ...base, ...parseConnectionString(parsedFlags['connection-string']) }
  }

  const password = await resolvePassword(parsedFlags)
  const connOptions: PostgresConnectionOptions = {
    host: parsedFlags.host ?? base.host,
    port: parsedFlags.port ?? base.port,
    user: parsedFlags.user ?? base.user,
    password: password ?? base.password,
    database: parsedFlags.database ?? base.database,
  }

  connOptions.ssl = await buildSslConfig(parsedFlags)

  let tunnel: Tunnel | undefined

  if (parsedFlags['ssh-host']) {
    if (!parsedFlags['ssh-user']) {
      throw new Error('--ssh-user is required when using --ssh-host')
    }
    if (!parsedFlags['ssh-key'] && !parsedFlags['ssh-password']) {
      throw new Error('--ssh-key or --ssh-password is required when using --ssh-host')
    }

    tunnel = await createTunnel({
      sshHost: parsedFlags['ssh-host'],
      sshPort: parsedFlags['ssh-port'] ?? 22,
      sshUser: parsedFlags['ssh-user'],
      sshKey: parsedFlags['ssh-key'],
      sshPassword: parsedFlags['ssh-password'],
      targetHost: connOptions.host,
      targetPort: connOptions.port,
    })

    connOptions.host = tunnel.localHost
    connOptions.port = tunnel.localPort
  }

  const client = createPostgresClient(connOptions)

  const server = new TuskMcpServer(client, {
    structureOnly: parsedFlags['structure-only'] ?? false,
  })

  const shutdown = async () => {
    await client.close()
    if (tunnel) await tunnel.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.start()
}

main().catch((err) => {
  console.error(`tusk-mcp: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
