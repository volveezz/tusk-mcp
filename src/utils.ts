import type {
  ColumnInfo,
  QueryResult,
  SchemaDiff,
  SchemaInfo,
  TableDescription,
  TableInfo,
  WriteResult,
} from './types.js'

const ALLOWED_PREFIXES = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'VALUES', 'TABLE']

const WRITE_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'COPY', 'MERGE', 'CALL',
  'DO', 'LOCK', 'REINDEX', 'REFRESH', 'CLUSTER', 'VACUUM',
  'DISCARD', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'PREPARE', 'DEALLOCATE', 'EXECUTE', 'REASSIGN', 'IMPORT',
]

/**
 * Strips SQL comments and string literals from a query so that keyword
 * detection operates only on actual SQL tokens, not on user data inside
 * strings or comments.
 */
function stripNonCode(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\$([^$]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
}

/**
 * Validates that a SQL query is read-only. Uses a two-pass approach:
 * 1. The first word must be an allowed prefix (SELECT, WITH, EXPLAIN, etc.)
 * 2. The entire query is scanned for write keywords (INSERT, DELETE, etc.)
 *    to block CTE-based attacks like `WITH x AS (DELETE FROM ...) SELECT ...`
 */
export function isReadOnlyQuery(query: string): boolean {
  const stripped = stripNonCode(query).trim()
  if (!stripped) return false

  const upper = stripped.toUpperCase()
  const firstWord = upper.split(/\s+/)[0]
  if (!ALLOWED_PREFIXES.includes(firstWord)) return false

  for (const keyword of WRITE_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upper)) return false
  }

  return true
}

/**
 * Parses a PostgreSQL connection string into individual components.
 * Does NOT use new URL() because it silently misparses # as a fragment
 * separator and can't handle unencoded @ in passwords. Instead, manually
 * splits on the LAST @ as the credential/host boundary, which handles any
 * special characters in passwords without requiring URL-encoding.
 * Fields absent from the string come back undefined so callers can layer
 * their own defaults (config merge, env fallback) without being clobbered.
 */
export function parseConnectionString(cs: string): {
  host?: string; port?: number; user?: string; password?: string; database?: string
} {
  const schemeEnd = cs.indexOf('://')
  if (schemeEnd === -1) throw new Error('Invalid connection string: expected postgresql:// prefix')

  const rest = cs.slice(schemeEnd + 3)
  const lastAt = rest.lastIndexOf('@')
  const userInfo = lastAt >= 0 ? rest.slice(0, lastAt) : ''
  const hostPart = rest.slice(lastAt + 1)

  const colonIdx = userInfo.indexOf(':')
  const user = colonIdx >= 0 ? decodeComponent(userInfo.slice(0, colonIdx)) : decodeComponent(userInfo)
  const password = colonIdx >= 0 ? decodeComponent(userInfo.slice(colonIdx + 1)) : undefined

  const pathIdx = hostPart.indexOf('/')
  const hostPort = pathIdx >= 0 ? hostPart.slice(0, pathIdx) : hostPart
  const dbRaw = pathIdx >= 0 ? hostPart.slice(pathIdx + 1) : undefined
  const database = dbRaw?.split('?')[0] || undefined

  const portIdx = hostPort.lastIndexOf(':')
  const host = portIdx >= 0 ? hostPort.slice(0, portIdx) : hostPort
  const port = portIdx >= 0 ? parseInt(hostPort.slice(portIdx + 1)) : NaN

  return {
    host: host || undefined,
    port: isNaN(port) ? undefined : port,
    user: user || undefined,
    password: password || undefined,
    database: database || undefined,
  }
}

function decodeComponent(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

type ToolTextContent = { type: 'text'; text: string }
type ToolResult = { content: ToolTextContent[]; structuredContent?: Record<string, unknown> }
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const QUERY_TEXT_PREVIEW_ROWS = 25
const MAX_CELL_CHARS = 240

interface SchemaOverview {
  name: string
  owner: string
  tables: Omit<TableInfo, 'schema'>[]
}

function prefixTarget(text: string, target: string, multiTarget: boolean): string {
  return multiTarget ? `target=${target}\n${text}` : text
}

export function formatOverviewResult(target: string, multiTarget: boolean, schemas: SchemaInfo[], tables: TableInfo[]): ToolResult {
  const bySchema = new Map<string, Omit<TableInfo, 'schema'>[]>()
  for (const { schema, ...table } of tables) {
    const group = bySchema.get(schema) ?? []
    group.push(table)
    bySchema.set(schema, group)
  }
  const overview: SchemaOverview[] = schemas.map(s => ({ name: s.name, owner: s.owner, tables: bySchema.get(s.name) ?? [] }))
  return {
    content: [{ type: 'text', text: prefixTarget(renderOverview(overview), target, multiTarget) }],
    structuredContent: { target, schemas: overview },
  }
}

export function formatTableDescriptionsResult(target: string, multiTarget: boolean, descriptions: TableDescription[]): ToolResult {
  const blocks = descriptions.map(d => d.columns.length === 0
    ? `${encodeAtom(d.schema)}.${encodeAtom(d.table)}: not found`
    : renderTableDescription(d))
  return {
    content: [{ type: 'text', text: prefixTarget(blocks.join('\n\n'), target, multiTarget) }],
    structuredContent: { target, tables: descriptions },
  }
}

export function formatSchemaDiffResult(diff: SchemaDiff): ToolResult {
  return {
    content: [{ type: 'text', text: renderSchemaDiff(diff) }],
    structuredContent: { diff },
  }
}

export function formatQueryResult(target: string, multiTarget: boolean, result: QueryResult): ToolResult {
  return {
    content: [{ type: 'text', text: prefixTarget(renderQueryResult(result), target, multiTarget) }],
    structuredContent: { target, result: queryPreview(result) },
  }
}

export function formatWriteResult(target: string, multiTarget: boolean, result: WriteResult): ToolResult {
  const header = `${result.command} affected=${result.affectedRows}`
  const text = result.returning ? `${header}\n${renderQueryResult(result.returning)}` : header
  const structuredContent: Record<string, unknown> = {
    target,
    command: result.command,
    affectedRows: result.affectedRows,
  }
  if (result.returning) structuredContent.returning = queryPreview(result.returning)

  return {
    content: [{ type: 'text', text: prefixTarget(text, target, multiTarget) }],
    structuredContent,
  }
}

/** Row preview shared by execute-query and execute-write RETURNING output. */
function queryPreview(result: QueryResult) {
  const previewRows = result.rows.slice(0, QUERY_TEXT_PREVIEW_ROWS)
  return {
    columns: result.columns,
    rows: previewRows.map(row => normalizeRow(row)),
    rowCount: result.rowCount,
    previewRowCount: previewRows.length,
    truncated: result.truncated,
    previewTruncated: previewRows.length < result.rows.length,
  }
}

export function formatToolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  }
}

function renderOverview(overview: SchemaOverview[]): string {
  const lines: string[] = []
  const empty: string[] = []
  for (const schema of overview) {
    if (schema.tables.length === 0) {
      empty.push(schema.name)
      continue
    }
    lines.push(`${encodeAtom(schema.name)}: ${schema.tables.map(t => `${encodeAtom(t.name)} ${t.type} ~${formatCount(t.estimatedRowCount)}`).join('; ')}`)
  }
  if (empty.length > 0) lines.push(`empty: ${empty.map(encodeAtom).join(', ')}`)
  if (overview.length === 0) lines.push('no schemas')
  return lines.join('\n')
}

function renderSchemaDiff(diff: SchemaDiff): string {
  const lines = [`${encodeAtom(diff.schema)}: ${diff.targetA} vs ${diff.targetB}`]
  if (diff.onlyInA.length > 0) lines.push(`only in ${diff.targetA}: ${diff.onlyInA.map(encodeAtom).join(', ')}`)
  if (diff.onlyInB.length > 0) lines.push(`only in ${diff.targetB}: ${diff.onlyInB.map(encodeAtom).join(', ')}`)
  if (diff.missing.length > 0) lines.push(`not found on either side: ${diff.missing.map(encodeAtom).join(', ')}`)
  for (const table of diff.tableDiffs) {
    const parts = table.changes.map(change => {
      if (change.b === null) return `${encodeAtom(change.column)} (${change.a}) only in ${diff.targetA}`
      if (change.a === null) return `${encodeAtom(change.column)} (${change.b}) only in ${diff.targetB}`
      return `${encodeAtom(change.column)}: ${change.a} vs ${change.b}`
    })
    lines.push(`${encodeAtom(table.table)}: ${parts.join('; ')}`)
  }
  lines.push(diff.comparedCount === 0
    ? 'no common tables'
    : `identical: ${diff.identicalCount}/${diff.comparedCount} tables`)
  return lines.join('\n')
}

/** Compact column signature (type, nullability, pk, enum) shared by describe-tables and compare-schemas so both render columns identically. */
export function columnSignature(column: ColumnInfo): string {
  const parts = [encodeAtom(column.type), column.nullable ? '?' : '!']
  if (column.isPrimaryKey) parts.push('pk')
  if (column.enumValues?.length) parts.push(`enum(${column.enumValues.map(encodeAtom).join(',')})`)
  return parts.join(' ')
}

function renderTableDescription(description: TableDescription): string {
  const fksByColumn = new Map<string, TableDescription['foreignKeys']>()
  for (const fk of description.foreignKeys) {
    const fks = fksByColumn.get(fk.columnName) ?? []
    fks.push(fk)
    fksByColumn.set(fk.columnName, fks)
  }

  const lines = [`${encodeAtom(description.schema)}.${encodeAtom(description.table)}`]

  for (const column of description.columns) {
    const parts = [encodeAtom(column.name), columnSignature(column)]
    if (column.defaultValue) parts.push(`default ${encodeAtom(compactWhitespace(column.defaultValue))}`)

    for (const fk of fksByColumn.get(column.name) ?? []) {
      parts.push(`-> ${encodeDottedName(fk.referencedTable)}.${encodeAtom(fk.referencedColumn)}(${encodeAtom(fk.constraintName)})`)
    }

    lines.push(parts.join(' '))
  }

  return lines.join('\n')
}

function renderQueryResult(result: QueryResult): string {
  const previewRows = result.rows.slice(0, QUERY_TEXT_PREVIEW_ROWS)
  const previewed = previewRows.length < result.rowCount
  const lines = [
    `rows=${result.rowCount} cols=${result.columns.length} truncated=${result.truncated} null=\\N`,
    `cols=${JSON.stringify(result.columns)}`,
  ]

  for (const row of previewRows) {
    lines.push(result.columns.map(column => renderCell(row[column])).join('\t'))
  }

  if (previewed) lines.push(`preview_rows=${previewRows.length}`)
  return lines.join('\n')
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '\\N'
  const rendered = typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
    ? String(value)
    : JSON.stringify(value) ?? String(value)
  return truncate(rendered, MAX_CELL_CHARS)
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3)}...`
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${trimFixed(count / 1_000_000)}m`
  if (count >= 1_000) return `${trimFixed(count / 1_000)}k`
  return String(count)
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

function encodeAtom(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(value) ? value : JSON.stringify(value)
}

function encodeDottedName(value: string): string {
  return value.split('.').map(encodeAtom).join('.')
}

function normalizeRow(row: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeJsonValue(value)]),
  )
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(item => normalizeJsonValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeJsonValue(item)]),
    )
  }
  return String(value)
}
