/**
 * `compare-schemas` tool: server-side structural diff of one schema between
 * two targets, so drift checks cost one compact call instead of dumping both
 * schemas into model context. Registered only with 2+ targets (server.ts).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TargetRegistry } from '../targets.js'
import type { ColumnChange, SchemaDiff, TableDescription, TableDiff } from '../types.js'
import { columnSignature, formatSchemaDiffResult, formatToolError } from '../utils.js'

const columnChangeSchema = z.object({
  column: z.string(),
  a: z.string().nullable().describe('null = absent in targetA'),
  b: z.string().nullable().describe('null = absent in targetB'),
})

const tableDiffSchema = z.object({
  table: z.string(),
  changes: z.array(columnChangeSchema),
})

const schemaDiffSchema = z.object({
  schema: z.string(),
  targetA: z.string(),
  targetB: z.string(),
  onlyInA: z.array(z.string()),
  onlyInB: z.array(z.string()),
  missing: z.array(z.string()).describe('Requested tables found in neither target'),
  tableDiffs: z.array(tableDiffSchema),
  comparedCount: z.number(),
  identicalCount: z.number(),
})

// describeTable issues 4 concurrent statements per table per target against
// pools of max 5; cap in-flight tables so a wide schema cannot queue
// thousands of statements behind one tool call
const COMPARE_CHUNK = 8

interface CompareInput {
  targetA: string
  targetB: string
  schema: string
  tables?: string[]
}

export function registerCompareTools(server: McpServer, registry: TargetRegistry): void {
  server.registerTool(
    'compare-schemas',
    {
      title: 'Compare Schemas',
      description: 'Diff table structure of one schema between two targets.',
      inputSchema: z.object({
        targetA: registry.targetEnum(),
        targetB: registry.targetEnum(),
        schema: z.string().default('public'),
        tables: z.array(z.string()).optional().describe('Unqualified table names to limit the diff'),
      }),
      outputSchema: z.object({ diff: schemaDiffSchema }),
    },
    async (input: CompareInput) => {
      if (input.targetA === input.targetB) {
        return formatToolError('targetA and targetB are the same target; nothing to compare.')
      }
      try {
        return formatSchemaDiffResult(await computeSchemaDiff(registry, input))
      } catch (err) {
        return formatToolError(`Failed to compare schemas: ${err instanceof Error ? err.message : err}`)
      }
    },
  )
}

async function computeSchemaDiff(registry: TargetRegistry, input: CompareInput): Promise<SchemaDiff> {
  const { targetA, targetB, schema, tables } = input
  const [clientA, clientB] = await Promise.all([registry.client(targetA), registry.client(targetB)])
  const [tablesA, tablesB] = await Promise.all([clientA.listTables(schema), clientB.listTables(schema)])

  const wanted = tables ? new Set(tables) : undefined
  const namesA = new Set(tablesA.map(t => t.name).filter(name => !wanted || wanted.has(name)))
  const namesB = new Set(tablesB.map(t => t.name).filter(name => !wanted || wanted.has(name)))
  const common = [...namesA].filter(name => namesB.has(name)).sort()
  const onlyInA = [...namesA].filter(name => !namesB.has(name)).sort()
  const onlyInB = [...namesB].filter(name => !namesA.has(name)).sort()
  const missing = wanted ? [...wanted].filter(name => !namesA.has(name) && !namesB.has(name)).sort() : []

  const described: TableDiff[] = []
  for (let i = 0; i < common.length; i += COMPARE_CHUNK) {
    described.push(...await Promise.all(common.slice(i, i + COMPARE_CHUNK).map(async table => {
      const [a, b] = await Promise.all([
        clientA.describeTable(table, schema),
        clientB.describeTable(table, schema),
      ])
      return { table, changes: diffColumns(a, b) } satisfies TableDiff
    })))
  }
  const tableDiffs = described.filter(diff => diff.changes.length > 0)

  return {
    schema,
    targetA,
    targetB,
    onlyInA,
    onlyInB,
    missing,
    tableDiffs,
    comparedCount: common.length,
    identicalCount: common.length - tableDiffs.length,
  }
}

function diffColumns(a: TableDescription, b: TableDescription): ColumnChange[] {
  const remainingB = new Map(b.columns.map(column => [column.name, column]))
  const changes: ColumnChange[] = []

  for (const columnA of a.columns) {
    const columnB = remainingB.get(columnA.name)
    remainingB.delete(columnA.name)
    if (!columnB) {
      changes.push({ column: columnA.name, a: columnSignature(columnA), b: null })
      continue
    }
    const signatureA = columnSignature(columnA)
    const signatureB = columnSignature(columnB)
    if (signatureA !== signatureB) changes.push({ column: columnA.name, a: signatureA, b: signatureB })
  }

  for (const columnB of remainingB.values()) {
    changes.push({ column: columnB.name, a: null, b: columnSignature(columnB) })
  }

  return changes
}
