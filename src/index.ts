#!/usr/bin/env node
import { parseArgs } from 'util'
import { configFromFlags, discoverConfig, loadConfigFrom, usedConnectionFlags } from './config.js'
import type { TuskConfig } from './config.js'
import { TargetRegistry } from './targets.js'
import { TuskMcpServer } from './server.js'
import type { ConnectionFlags } from './types.js'

function printUsage(): void {
  const lines = [
    'tusk-mcp - Read-only PostgreSQL MCP server for AI agents',
    '',
    'Usage:',
    '  tusk-mcp --host <host> --database <db>     Start MCP server (stdio)',
    '  tusk-mcp --config <path>                   Start with a multi-target config',
    '  tusk-mcp setup                             Interactive browser-based setup',
    '',
    'Config file:',
    '  Auto-loads tusk.config.jsonc|json from cwd when no connection flags are set.',
    '  --config <path> loads an explicit file. Named targets (local/stage/prod or',
    '  separate databases), per-target structureOnly, selected via target param.',
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
    '  --structure-only           Disable execute-query tool',
    '',
    'This is an MCP server that communicates over stdio.',
    'It should be launched by an MCP client (Claude Desktop, Cursor, etc.),',
    'not run directly in a terminal.',
    '',
    'Run "tusk-mcp setup" to configure your MCP client interactively.',
  ]
  console.log(lines.join('\n'))
}

async function resolveConfig(flags: ConnectionFlags): Promise<TuskConfig> {
  const connectionFlags = usedConnectionFlags(flags)

  let config: TuskConfig | undefined
  if (flags.config) {
    if (connectionFlags.length > 0) {
      throw new Error(`--config cannot be combined with connection flags (${connectionFlags.map(f => `--${f}`).join(', ')}); put connection settings in the config file`)
    }
    config = await loadConfigFrom(flags.config)
    console.error(`tusk-mcp: loaded ${flags.config} (targets: ${Object.keys(config.targets).join(', ')})`)
  } else if (connectionFlags.length === 0) {
    const discovered = await discoverConfig()
    if (discovered) {
      config = discovered.config
      console.error(`tusk-mcp: loaded ${discovered.path} (targets: ${Object.keys(config.targets).join(', ')})`)
    }
  }
  config ??= configFromFlags(flags)

  if (flags['structure-only']) {
    for (const target of Object.values(config.targets)) target.structureOnly = true
  }
  return config
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
