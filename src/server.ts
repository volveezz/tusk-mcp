import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { TargetRegistry } from './targets.js'
import { registerSchemaTools } from './tools/schema.js'
import { registerQueryTools } from './tools/query.js'
import { registerCompareTools } from './tools/compare.js'

export class TuskMcpServer {
  private mcpServer: McpServer
  private registry: TargetRegistry

  constructor(registry: TargetRegistry) {
    this.registry = registry
    this.mcpServer = new McpServer(
      { name: 'tusk-mcp', version: '0.2.0' },
      { instructions: buildInstructions(registry) },
    )
  }

  registerAllTools(): void {
    registerSchemaTools(this.mcpServer, this.registry)

    if (this.registry.anyQueryable) {
      registerQueryTools(this.mcpServer, this.registry)
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
  if (!registry.multiTarget) return undefined
  const entries = registry.names().map(name => {
    const notes = [
      registry.description(name),
      registry.isStructureOnly(name) ? 'structure-only, no queries' : undefined,
    ].filter(Boolean)
    return notes.length > 0 ? `${name} (${notes.join('; ')})` : name
  })
  const suffix = registry.defaultTarget ? ` Default target: ${registry.defaultTarget}.` : ''
  return `Database targets: ${entries.join(', ')}.${suffix}`
}
