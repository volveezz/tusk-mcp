import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { version } from '../package.json'
import type { AccessLevel } from './config.js'
import type { TargetRegistry } from './targets.js'
import { registerSchemaTools } from './tools/schema.js'
import { registerQueryTools } from './tools/query.js'
import { registerWriteTools } from './tools/write.js'
import { registerCompareTools } from './tools/compare.js'

export class TuskMcpServer {
  private mcpServer: McpServer
  private registry: TargetRegistry

  constructor(registry: TargetRegistry) {
    this.registry = registry
    this.mcpServer = new McpServer(
      { name: 'tusk-mcp', version },
      { instructions: buildInstructions(registry) },
    )
  }

  registerAllTools(): void {
    registerSchemaTools(this.mcpServer, this.registry)

    if (this.registry.anyQueryable) {
      registerQueryTools(this.mcpServer, this.registry)
    }

    if (this.registry.anyWritable) {
      registerWriteTools(this.mcpServer, this.registry)
    }

    if (this.registry.multiTarget) {
      registerCompareTools(this.mcpServer, this.registry)
    }
  }

  async start(): Promise<void> {
    this.registerAllTools()
    const transport = new StdioServerTransport()
    await this.mcpServer.connect(transport)
  }
}

function buildInstructions(registry: TargetRegistry): string | undefined {
  if (!registry.multiTarget) {
    return registry.canWrite(registry.names()[0])
      ? 'Writes are enabled through execute-write; execute-query stays read-only.'
      : undefined
  }
  const entries = registry.names().map(name => {
    const notes = [
      registry.description(name),
      accessNote(registry.access(name)),
    ].filter(Boolean)
    return notes.length > 0 ? `${name} (${notes.join('; ')})` : name
  })
  const suffix = registry.defaultTarget ? ` Default target: ${registry.defaultTarget}.` : ''
  return `Database targets: ${entries.join(', ')}.${suffix}`
}

function accessNote(access: AccessLevel): string | undefined {
  if (access === 'structure') return 'structure-only, no queries'
  if (access === 'write') return 'writes enabled'
  return undefined
}
