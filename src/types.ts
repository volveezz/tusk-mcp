/**
 * Shared types: CLI flags, connection options, tunnel, introspection results,
 * schema-diff shapes, and the PostgresClient interface implemented by
 * client.ts. Target/config types live in config.ts, inferred from the zod
 * schemas that validate them.
 */
export interface ConnectionFlags {
  config?: string
  host?: string
  port?: number
  user?: string
  password?: string
  'password-file'?: string
  'password-cmd'?: string
  database?: string
  'connection-string'?: string
  ssl?: boolean
  'ssl-ca'?: string
  'ssl-cert'?: string
  'ssl-key'?: string
  'ssh-host'?: string
  'ssh-port'?: number
  'ssh-user'?: string
  'ssh-key'?: string
  'ssh-password'?: string
  'structure-only'?: boolean
  'allow-writes'?: boolean
}

export interface PostgresConnectionOptions {
  host: string
  port: number
  user?: string
  password?: string
  database?: string
  /** Pins the session to read-only transactions server-side; false only for access: "write" targets. */
  readOnly: boolean
  ssl?: boolean | {
    rejectUnauthorized?: boolean
    ca?: string
    cert?: string
    key?: string
  }
}

export interface TunnelOptions {
  sshHost: string
  sshPort: number
  sshUser: string
  sshKey?: string
  sshPassword?: string
  targetHost: string
  targetPort: number
}

export interface Tunnel {
  localHost: string
  localPort: number
  close: () => Promise<void>
}

export interface SchemaInfo {
  name: string
  owner: string
}

export interface TableInfo {
  schema: string
  name: string
  type: 'table' | 'view' | 'partitioned table' | 'materialized view'
  estimatedRowCount: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  enumValues?: string[]
}

export interface ForeignKeyInfo {
  columnName: string
  referencedTable: string
  referencedColumn: string
  constraintName: string
}

export interface TableDescription {
  schema: string
  table: string
  columns: ColumnInfo[]
  foreignKeys: ForeignKeyInfo[]
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

export interface WriteResult {
  command: string
  affectedRows: number
  /** Present only when the statement produced rows (RETURNING, or a function call). */
  returning?: QueryResult
}

export interface ColumnChange {
  column: string
  a: string | null
  b: string | null
}

export interface TableDiff {
  table: string
  changes: ColumnChange[]
}

export interface SchemaDiff {
  schema: string
  targetA: string
  targetB: string
  onlyInA: string[]
  onlyInB: string[]
  missing: string[]
  tableDiffs: TableDiff[]
  comparedCount: number
  identicalCount: number
}

export interface PostgresClient {
  listSchemas(): Promise<SchemaInfo[]>
  listTables(schema?: string): Promise<TableInfo[]>
  describeTable(table: string, schema: string): Promise<TableDescription>
  executeQuery(query: string, limit: number): Promise<QueryResult>
  executeWrite(statement: string, limit: number): Promise<WriteResult>
  close(): Promise<void>
}
