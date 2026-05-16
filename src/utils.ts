import type {
  QueryResult,
  SchemaInfo,
  TableDescription,
  TableInfo,
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
 * splits on the LAST @ as the credential/host boundary — this correctly
 * handles any special characters in passwords without requiring URL-encoding.
 */
export function parseConnectionString(cs: string): {
  host: string; port: number; user?: string; password?: string; database?: string
} {
  const schemeEnd = cs.indexOf('://')
  if (schemeEnd === -1) throw new Error('Invalid connection string — expected postgresql:// prefix')

  const rest = cs.slice(schemeEnd + 3)
  const lastAt = rest.lastIndexOf('@')
  if (lastAt === -1) throw new Error('Invalid connection string — missing @ between credentials and host')

  const userInfo = rest.slice(0, lastAt)
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
  const port = portIdx >= 0 ? parseInt(hostPort.slice(portIdx + 1)) : 5432

  return {
    host: host || 'localhost',
    port: isNaN(port) ? 5432 : port,
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

export function formatSchemasResult(schemas: SchemaInfo[]): ToolResult {
  return {
    content: [{ type: 'text', text: renderSchemas(schemas) }],
    structuredContent: { schemas },
  }
}

export function formatTablesResult(schema: string, tables: TableInfo[]): ToolResult {
  return {
    content: [{ type: 'text', text: renderTables(schema, tables) }],
    structuredContent: { schema, tables },
  }
}

export function formatTableDescriptionResult(description: TableDescription): ToolResult {
  return {
    content: [{ type: 'text', text: renderTableDescription(description) }],
    structuredContent: { table: description },
  }
}

export function formatQueryResult(result: QueryResult): ToolResult {
  const previewRows = result.rows.slice(0, QUERY_TEXT_PREVIEW_ROWS)
  const structuredResult = {
    columns: result.columns,
    rows: previewRows.map(row => normalizeRow(row)),
    rowCount: result.rowCount,
    returnedRowCount: result.rows.length,
    previewRowCount: previewRows.length,
    truncated: result.truncated,
    previewTruncated: previewRows.length < result.rows.length,
  }

  return {
    content: [{ type: 'text', text: renderQueryResult(result) }],
    structuredContent: { result: structuredResult },
  }
}

export function formatToolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  }
}

function renderSchemas(schemas: SchemaInfo[]): string {
  if (schemas.length === 0) return 'schemas: none'
  return `schemas: ${schemas.map(s => `${encodeAtom(s.name)}(owner=${encodeAtom(s.owner)})`).join(', ')}`
}

function renderTables(schema: string, tables: TableInfo[]): string {
  const schemaName = encodeAtom(schema)
  if (tables.length === 0) return `${schemaName}: no tables or views`
  return `${schemaName}: ${tables.map(t => `${encodeAtom(t.name)} ${t.type} ~${formatCount(t.estimatedRowCount)}`).join('; ')}`
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
    const parts = [encodeAtom(column.name), encodeAtom(column.type)]
    if (column.isPrimaryKey) parts.push('pk')
    parts.push(column.nullable ? '?' : '!')
    if (column.defaultValue) parts.push(`default ${encodeAtom(compactWhitespace(column.defaultValue))}`)
    if (column.enumValues?.length) parts.push(`enum(${column.enumValues.map(encodeAtom).join(',')})`)

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

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? String(value)
}

function renderCell(value: unknown): string {
  const rendered = renderValue(value)

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
