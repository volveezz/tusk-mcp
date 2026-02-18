import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PostgresClient } from '../types.js'
import { isReadOnlyQuery, formatToolResult, formatToolError } from '../utils.js'

export function registerQueryTools(server: McpServer, client: PostgresClient): void {
  server.registerTool(
    'execute-query',
    {
      title: 'Execute Query',
      description: 'Execute a read-only SQL query. Only SELECT, WITH, EXPLAIN, SHOW, and VALUES are allowed. Results are limited by the limit parameter.',
      inputSchema: z.object({
        query: z.string().describe('SQL query to execute (read-only)'),
        limit: z.number().min(1).max(5000).default(500).describe('Max rows to return (default: 500, max: 5000)'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query, limit }) => {
      if (!isReadOnlyQuery(query)) {
        return formatToolError('Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW, VALUES).')
      }

      try {
        const result = await client.executeQuery(query, limit)
        return formatToolResult(result)
      } catch (err) {
        return formatToolError(`Query failed: ${err instanceof Error ? err.message : err}`)
      }
    },
  )
}
