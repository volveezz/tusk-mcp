/**
 * Introspection tools: `overview` (all schemas + tables + row counts in one
 * call) and `describe-tables` (batched, multiple tables per call).
 * Both take a `target` enum param when several targets are configured.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TargetRegistry } from '../targets.js'
import { formatOverviewResult, formatTableDescriptionsResult, formatToolError } from '../utils.js'

const tableInfoSchema = z.object({
  name: z.string(),
  type: z.enum(['table', 'view', 'partitioned table', 'materialized view']),
  estimatedRowCount: z.number(),
})

const schemaOverviewSchema = z.object({
  name: z.string(),
  owner: z.string(),
  tables: z.array(tableInfoSchema),
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

const tableDescriptionSchema = z.object({
  schema: z.string(),
  table: z.string(),
  columns: z.array(columnInfoSchema),
  foreignKeys: z.array(foreignKeyInfoSchema),
})

export function registerSchemaTools(server: McpServer, registry: TargetRegistry): void {
  const targetShape = registry.targetShape()

  server.registerTool(
    'overview',
    {
      title: 'Database Overview',
      description: 'All schemas with their tables, views, and estimated row counts.',
      inputSchema: z.object({
        ...targetShape,
        schema: z.string().optional(),
      }),
      outputSchema: z.object({
        target: z.string(),
        schemas: z.array(schemaOverviewSchema),
      }),
    },
    async (input: { target?: string; schema?: string }) => {
      try {
        const target = registry.resolveName(input.target)
        const client = await registry.client(target)
        const [schemas, tables] = await Promise.all([
          client.listSchemas(),
          client.listTables(input.schema),
        ])
        const filtered = input.schema ? schemas.filter(s => s.name === input.schema) : schemas
        if (input.schema && filtered.length === 0) {
          return formatToolError(`Schema "${input.schema}" not found.`)
        }
        return formatOverviewResult(target, registry.multiTarget, filtered, tables)
      } catch (err) {
        return formatToolError(`Failed to load overview: ${err instanceof Error ? err.message : err}`)
      }
    },
  )

  server.registerTool(
    'describe-tables',
    {
      title: 'Describe Tables',
      description: 'Columns, primary keys, and foreign keys for one or more tables.',
      inputSchema: z.object({
        ...targetShape,
        tables: z.array(z.string()).min(1).describe('Table names, optionally schema-qualified'),
        schema: z.string().default('public').describe('Schema for unqualified names'),
      }),
      outputSchema: z.object({
        target: z.string(),
        tables: z.array(tableDescriptionSchema),
      }),
    },
    async (input: { target?: string; tables: string[]; schema: string }) => {
      try {
        const target = registry.resolveName(input.target)
        const client = await registry.client(target)
        const descriptions = await Promise.all([...new Set(input.tables)].map(name => {
          const dot = name.lastIndexOf('.')
          return dot >= 0
            ? client.describeTable(name.slice(dot + 1), name.slice(0, dot))
            : client.describeTable(name, input.schema)
        }))
        return formatTableDescriptionsResult(target, registry.multiTarget, descriptions)
      } catch (err) {
        return formatToolError(`Failed to describe tables: ${err instanceof Error ? err.message : err}`)
      }
    },
  )
}
