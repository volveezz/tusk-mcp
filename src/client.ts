import postgres from 'postgres'
import type {
  PostgresClient,
  PostgresConnectionOptions,
  SchemaInfo,
  TableInfo,
  TableDescription,
  QueryResult,
} from './types.js'

export function createPostgresClient(options: PostgresConnectionOptions): PostgresClient {
  const sql = postgres({
    host: options.host,
    port: options.port,
    username: options.user,
    password: options.password,
    database: options.database,
    ssl: options.ssl
      ? (typeof options.ssl === 'object' ? options.ssl : { rejectUnauthorized: false })
      : false,
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: 'tusk-mcp' },
  })

  return {
    async listSchemas(): Promise<SchemaInfo[]> {
      const rows = await sql`
        SELECT schema_name AS name, schema_owner AS owner
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND schema_name NOT LIKE 'pg_temp_%'
          AND schema_name NOT LIKE 'pg_toast_temp_%'
        ORDER BY schema_name
      `
      return rows as unknown as SchemaInfo[]
    },

    async listTables(schema: string): Promise<TableInfo[]> {
      const rows = await sql`
        SELECT
          s.schemaname AS schema,
          s.relname AS name,
          CASE
            WHEN s.relname IN (
              SELECT viewname FROM pg_views WHERE schemaname = ${schema}
            ) THEN 'view'
            WHEN c.relkind = 'p' THEN 'partitioned table'
            ELSE 'table'
          END AS type,
          COALESCE(s.n_live_tup, 0) AS "estimatedRowCount"
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.relname = s.relname
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
        WHERE s.schemaname = ${schema}
          AND c.oid NOT IN (SELECT inhrelid FROM pg_inherits)

        UNION ALL

        SELECT
          schemaname AS schema,
          viewname AS name,
          'view' AS type,
          0 AS "estimatedRowCount"
        FROM pg_views
        WHERE schemaname = ${schema}
          AND viewname NOT IN (
            SELECT relname FROM pg_stat_user_tables WHERE schemaname = ${schema}
          )

        ORDER BY name
      `
      return rows.map(r => ({
        schema: r.schema as string,
        name: r.name as string,
        type: r.type as 'table' | 'view' | 'partitioned table',
        estimatedRowCount: Number(r.estimatedRowCount),
      }))
    },

    async describeTable(table: string, schema: string): Promise<TableDescription> {
      const [columns, foreignKeys, primaryKeys, enums] = await Promise.all([
        sql`
          SELECT
            column_name AS name,
            CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END AS type,
            is_nullable = 'YES' AS nullable,
            column_default AS "defaultValue",
            udt_name AS "udtName"
          FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = ${table}
          ORDER BY ordinal_position
        `,
        sql`
          SELECT
            kcu.column_name AS "columnName",
            ccu.table_schema || '.' || ccu.table_name AS "referencedTable",
            ccu.column_name AS "referencedColumn",
            tc.constraint_name AS "constraintName"
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = ${schema}
            AND tc.table_name = ${table}
        `,
        sql`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = ${schema}
            AND tc.table_name = ${table}
        `,
        sql`
          SELECT t.typname AS name, ARRAY_AGG(e.enumlabel ORDER BY e.enumsortorder) AS values
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE n.nspname = ${schema}
            AND t.typname IN (
              SELECT udt_name FROM information_schema.columns
              WHERE table_schema = ${schema} AND table_name = ${table} AND data_type = 'USER-DEFINED'
            )
          GROUP BY t.typname
        `,
      ])

      const pkColumns = new Set(primaryKeys.map(r => r.column_name as string))
      const enumMap = new Map(enums.map(e => [e.name as string, e.values as string[]]))

      return {
        schema,
        table,
        columns: columns.map(c => {
          const col: Record<string, unknown> = {
            name: c.name as string,
            type: c.type as string,
            nullable: c.nullable as boolean,
            defaultValue: c.defaultValue as string | null,
            isPrimaryKey: pkColumns.has(c.name as string),
          }
          const enumValues = enumMap.get(c.udtName as string)
          if (enumValues) col.enumValues = enumValues
          return col
        }) as TableDescription['columns'],
        foreignKeys: foreignKeys.map(fk => ({
          columnName: fk.columnName as string,
          referencedTable: fk.referencedTable as string,
          referencedColumn: fk.referencedColumn as string,
          constraintName: fk.constraintName as string,
        })),
      }
    },

    async executeQuery(query: string, limit: number): Promise<QueryResult> {
      const effectiveLimit = Math.min(limit, 5000)
      const cleaned = query.replace(/;\s*$/, '').trim()
      const fetchCount = effectiveLimit + 1

      let rows: postgres.RowList<postgres.Row[]>
      try {
        rows = await sql.unsafe(
          `SELECT * FROM (${cleaned}) AS _tusk_result LIMIT ${fetchCount}`
        )
      } catch {
        rows = await sql.unsafe(`${cleaned} LIMIT ${fetchCount}`)
      }

      const truncated = rows.length > effectiveLimit
      const resultRows = truncated ? rows.slice(0, effectiveLimit) : [...rows]
      const columns = rows.length > 0 ? Object.keys(rows[0]) : (rows.columns?.map(c => c.name) ?? [])

      return {
        columns,
        rows: resultRows as Record<string, unknown>[],
        rowCount: resultRows.length,
        truncated,
      }
    },

    async close(): Promise<void> {
      await sql.end()
    },
  }
}
