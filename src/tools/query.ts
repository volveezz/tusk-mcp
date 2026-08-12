/**
 * `execute-query` tool: read-only SQL against a target, on every target that
 * is not structure-only, write-enabled ones included. Registered only when at
 * least one target allows queries; structure-only targets reject at call time
 * so one open target never unlocks the others.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TargetRegistry } from '../targets.js'
import { isReadOnlyQuery, formatQueryResult, formatToolError } from '../utils.js'

export function registerQueryTools(server: McpServer, registry: TargetRegistry): void {
  const structureOnlyTargets = registry.names().filter(name => registry.isStructureOnly(name))
  const description = 'Read-only SQL (SELECT, WITH, EXPLAIN, SHOW, VALUES).'
    + (structureOnlyTargets.length > 0 ? ` Unavailable on structure-only targets: ${structureOnlyTargets.join(', ')}.` : '')
    + (registry.anyWritable ? ' Mutating statements go through execute-write.' : '')

  server.registerTool(
    'execute-query',
    {
      title: 'Execute Query',
      description,
      inputSchema: z.object({
        ...registry.targetShape(),
        query: z.string(),
        limit: z.number().min(1).max(5000).default(500).describe('Max rows returned'),
      }),
      outputSchema: z.object({
        target: z.string(),
        result: z.object({
          columns: z.array(z.string()),
          rows: z.array(z.record(z.unknown())),
          rowCount: z.number(),
          previewRowCount: z.number(),
          truncated: z.boolean(),
          previewTruncated: z.boolean(),
        }),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: { target?: string; query: string; limit: number }) => {
      if (!isReadOnlyQuery(input.query)) {
        return formatToolError('Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW, VALUES).')
      }

      try {
        const target = registry.resolveName(input.target)
        if (registry.isStructureOnly(target)) {
          const queryable = registry.queryableNames()
          return formatToolError(`Target "${target}" is structure-only.`
            + (queryable.length > 0 ? ` Queryable targets: ${queryable.join(', ')}.` : ''))
        }
        const client = await registry.client(target)
        const result = await client.executeQuery(input.query, input.limit)
        return formatQueryResult(target, registry.multiTarget, result)
      } catch (err) {
        return formatToolError(`Query failed: ${err instanceof Error ? err.message : err}`)
      }
    },
  )
}
