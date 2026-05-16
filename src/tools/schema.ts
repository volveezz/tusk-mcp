import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PostgresClient } from '../types.js'
import {
  formatSchemasResult,
  formatTableDescriptionResult,
  formatTablesResult,
  formatToolError,
} from '../utils.js'

const schemaInfoSchema = z.object({
  name: z.string(),
  owner: z.string(),
})

const tableInfoSchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(['table', 'view', 'partitioned table']),
  estimatedRowCount: z.number(),
})

const columnInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  isPrimaryKey: z.boolean(),
  enumValues: z.array(z.string()).optional(),
})

const foreignKeyInfoSchema = z.object({
  columnName: z.string(),
  referencedTable: z.string(),
  referencedColumn: z.string(),
  constraintName: z.string(),
})

export function registerSchemaTools(server: McpServer, client: PostgresClient): void {
  server.registerTool(
    'list-schemas',
    {
      title: 'List Schemas',
      description: 'List all non-system schemas in the database with their owners.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        schemas: z.array(schemaInfoSchema),
      }),
    },
    async () => {
      try {
        const schemas = await client.listSchemas()
        return formatSchemasResult(schemas)
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
      outputSchema: z.object({
        schema: z.string(),
        tables: z.array(tableInfoSchema),
      }),
    },
    async ({ schema }) => {
      try {
        const tables = await client.listTables(schema)
        return formatTablesResult(schema, tables)
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
      outputSchema: z.object({
        table: z.object({
          schema: z.string(),
          table: z.string(),
          columns: z.array(columnInfoSchema),
          foreignKeys: z.array(foreignKeyInfoSchema),
        }),
      }),
    },
    async ({ table, schema }) => {
      try {
        const description = await client.describeTable(table, schema)
        return formatTableDescriptionResult(description)
      } catch (err) {
        return formatToolError(`Failed to describe table: ${err instanceof Error ? err.message : err}`)
      }
    },
  )

}
