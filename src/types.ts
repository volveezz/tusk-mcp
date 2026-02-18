export interface ConnectionFlags {
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
}

export interface PostgresConnectionOptions {
  host: string
  port: number
  user?: string
  password?: string
  database?: string
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
  type: 'table' | 'view' | 'partitioned table'
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

export interface PostgresClient {
  listSchemas(): Promise<SchemaInfo[]>
  listTables(schema: string): Promise<TableInfo[]>
  describeTable(table: string, schema: string): Promise<TableDescription>
  executeQuery(query: string, limit: number): Promise<QueryResult>
  close(): Promise<void>
}
