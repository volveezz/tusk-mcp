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

export function formatToolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function formatToolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  }
}
