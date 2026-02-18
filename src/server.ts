import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { PostgresClient } from './types.js'
import { registerSchemaTools } from './tools/schema.js'
import { registerQueryTools } from './tools/query.js'

interface TuskServerOptions {
  structureOnly: boolean
}

export class TuskMcpServer {
  private mcpServer: McpServer
  private client: PostgresClient
  private structureOnly: boolean

  constructor(client: PostgresClient, options: TuskServerOptions) {
    this.client = client
    this.structureOnly = options.structureOnly
    this.mcpServer = new McpServer({
      name: 'tusk-mcp',
      version: '0.1.0',
    })
  }

  registerAllTools(): void {
    registerSchemaTools(this.mcpServer, this.client)

    if (!this.structureOnly) {
      registerQueryTools(this.mcpServer, this.client)
    }
  }

  async start(): Promise<void> {
    this.registerAllTools()
    const transport = new StdioServerTransport()
    await this.mcpServer.connect(transport)
  }
}
