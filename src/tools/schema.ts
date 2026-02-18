import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PostgresClient } from '../types.js'
import { formatToolResult, formatToolError } from '../utils.js'

export function registerSchemaTools(server: McpServer, client: PostgresClient): void {
  server.registerTool(
    'list-schemas',
    {
      title: 'List Schemas',
      description: 'List all non-system schemas in the database with their owners.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const schemas = await client.listSchemas()
        return formatToolResult(schemas)
      } catch (err) {
        return formatToolError(`Failed to list schemas: ${err instanceof Error ? err.message : err}`)
      }
    },
  )

  server.registerTool(
    'list-tables',
    {
      title: 'List Tables',
      description: 'List all tables and views in a schema with estimated row counts.',
      inputSchema: z.object({
        schema: z.string().default('public').describe('Schema name (default: public)'),
      }),
    },
    async ({ schema }) => {
      try {
        const tables = await client.listTables(schema)
        return formatToolResult(tables)
      } catch (err) {
        return formatToolError(`Failed to list tables: ${err instanceof Error ? err.message : err}`)
      }
    },
  )

  server.registerTool(
    'describe-table',
    {
      title: 'Describe Table',
      description: 'Get detailed column info, primary keys, and foreign keys for a table.',
      inputSchema: z.object({
        table: z.string().describe('Table name'),
        schema: z.string().default('public').describe('Schema name (default: public)'),
      }),
    },
    async ({ table, schema }) => {
      try {
        const description = await client.describeTable(table, schema)
        return formatToolResult(description)
      } catch (err) {
        return formatToolError(`Failed to describe table: ${err instanceof Error ? err.message : err}`)
      }
    },
  )

}
