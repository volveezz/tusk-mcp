#!/usr/bin/env node
import { parseArgs } from 'util'
import { resolveConfig } from './config.js'
import { TargetRegistry } from './targets.js'
import { TuskMcpServer } from './server.js'
import type { ConnectionFlags } from './types.js'

function printUsage(): void {
  const lines = [
    'tusk-mcp - PostgreSQL MCP server for AI agents, read-only by default',
    '',
    'Usage:',
    '  tusk-mcp --host <host> --database <db>     Start MCP server (stdio)',
    '  tusk-mcp --config <path>                   Start with a multi-target config',
    '  tusk-mcp setup                             Interactive browser-based setup',
    '',
    'Config file:',
    '  Auto-loads tusk.config.jsonc|json from cwd when no connection flags are set.',
    '  --config <path> loads an explicit file. Named targets (local/stage/prod or',
    '  separate databases), per-target access (structure|read|write), selected',
    '  via the target param.',
    '',
    'Connection:',
    '  --host <host>              PostgreSQL host (default: localhost)',
    '  --port <port>              PostgreSQL port (default: 5432)',
    '  --user <user>              Database user',
    '  --password <pass>          Database password',
    '  --password-file <path>     Read password from file',
    '  --password-cmd <cmd>       Run command for password',
    '  --database <name>          Database name',
    '  --connection-string <url>  Full connection URL',
    '',
    'SSL:',
    '  --ssl                      Enable SSL without certificate verification',
    '  --ssl-ca <path>            CA certificate (enables SSL)',
    '  --ssl-cert <path>          Client certificate (enables SSL)',
    '  --ssl-key <path>           Client key (enables SSL)',
    '',
    'SSH tunnel:',
    '  --ssh-host <host>          SSH tunnel host',
    '  --ssh-port <port>          SSH tunnel port (default: 22)',
    '  --ssh-user <user>          SSH username',
    '  --ssh-key <path>           SSH private key path',
    '  --ssh-password <pass>      SSH password',
    '',
    'Options:',
    '  --structure-only           Schema only, no execute-query tool',
    '  --allow-writes             Add execute-write for mutating SQL (no config file)',
    '',
    'This is an MCP server that communicates over stdio.',
    'It should be launched by an MCP client (Claude Desktop, Cursor, etc.),',
    'not run directly in a terminal.',
    '',
    'Run "tusk-mcp setup" to configure your MCP client interactively.',
  ]
  console.log(lines.join('\n'))
}

function parsePort(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const port = parseInt(value, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${flag} must be a port number, got "${value}"`)
  }
  return port
}

async function main() {
  if (process.argv.includes('setup')) {
    const { startSetup } = await import('./setup.js')
    await startSetup()
    return
  }

  if (process.stdin.isTTY) {
    printUsage()
    process.exit(0)
  }

  const { values: flags } = parseArgs({
    options: {
      config: { type: 'string' },
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
      'allow-writes': { type: 'boolean', default: false },
    },
    strict: true,
  })

  const parsedFlags: ConnectionFlags = {
    ...flags,
    port: parsePort(flags.port, '--port'),
    'ssh-port': parsePort(flags['ssh-port'], '--ssh-port'),
  }

  const config = await resolveConfig(parsedFlags)
  const registry = new TargetRegistry(config)
  const server = new TuskMcpServer(registry)

  const shutdown = async () => {
    await registry.closeAll()
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
