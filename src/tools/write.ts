/**
 * `execute-write` tool: mutating SQL against targets configured with
 * access: "write". Registered only when such a target exists, and its target
 * enum lists write-enabled targets only, so read targets cannot be named
 * here at all. Read and structure targets also run with
 * default_transaction_read_only on, which makes the server the last word
 * regardless of this gate.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TargetRegistry } from '../targets.js'
import { formatWriteResult, formatToolError } from '../utils.js'

// Rejected up front rather than left to the server: the pool hands the next
// tool call a different connection, so a transaction opened here can never be
// committed and a session setting here silently changes an unrelated query
const UNSUPPORTED_PREFIXES = ['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SET', 'RESET', 'DISCARD']

export function registerWriteTools(server: McpServer, registry: TargetRegistry): void {
  const writable = registry.writableNames()
  const description = 'Mutating SQL (INSERT, UPDATE, DELETE, DDL, functions that write). One statement per call.'
    + ' Use execute-query for reads, it paginates.'
    + (registry.multiTarget ? ` Write-enabled targets: ${writable.join(', ')}.` : '')

  server.registerTool(
    'execute-write',
    {
      title: 'Execute Write',
      description,
      inputSchema: z.object({
        ...registry.writeTargetShape(),
        statement: z.string().trim().min(1).describe('A single SQL statement; add RETURNING to see affected rows'),
        limit: z.number().min(1).max(5000).default(500).describe('Max RETURNING rows shown'),
      }),
      outputSchema: z.object({
        target: z.string(),
        command: z.string(),
        affectedRows: z.number(),
        returning: z.object({
          columns: z.array(z.string()),
          rows: z.array(z.record(z.unknown())),
          rowCount: z.number(),
          previewRowCount: z.number(),
          truncated: z.boolean(),
          previewTruncated: z.boolean(),
        }).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    // no read-only guard on the statement: `SELECT writing_function()` is a
    // legitimate write here, and execute-query cannot run it on any target
    async (input: { target?: string; statement: string; limit: number }) => {
      const firstWord = input.statement.trim().split(/[\s(;]/, 1)[0].toUpperCase()
      if (UNSUPPORTED_PREFIXES.includes(firstWord)) {
        return formatToolError(`${firstWord} is not supported: statements run one per call on a pooled connection,`
          + ' so transactions and session settings cannot outlive the call. Write a single self-contained statement.')
      }

      try {
        const target = registry.resolveName(input.target)
        if (!registry.canWrite(target)) {
          return formatToolError(`Target "${target}" is ${registry.access(target)}-only.`
            + ` Write-enabled targets: ${writable.join(', ')}.`)
        }
        const client = await registry.client(target)
        const result = await client.executeWrite(input.statement, input.limit)
        return formatWriteResult(target, registry.multiTarget, result)
      } catch (err) {
        return formatToolError(`Write failed: ${err instanceof Error ? err.message : err}`)
      }
    },
  )
}
