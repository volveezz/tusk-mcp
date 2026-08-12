import postgres from 'postgres'
import type {
  PostgresClient,
  PostgresConnectionOptions,
  SchemaInfo,
  TableInfo,
  TableDescription,
  QueryResult,
  WriteResult,
} from './types.js'

/**
 * Every execute-query statement runs here, write-enabled targets included:
 * their pool cannot carry the read-only session pin, so the transaction is
 * what keeps `SELECT some_writing_function()` from mutating through a tool
 * that advertises readOnlyHint. The cast restores postgres.js result
 * metadata (count, columns) that begin()'s array-unwrapping type discards.
 */
function readOnlyTransaction(sql: postgres.Sql, statement: string): Promise<postgres.RowList<postgres.Row[]>> {
  return sql.begin(async tx => {
    await run(tx, 'SET TRANSACTION READ ONLY')
    return await run(tx, statement)
  }) as unknown as Promise<postgres.RowList<postgres.Row[]>>
}

/**
 * simple: false forces the extended protocol, whose one-command-per-message
 * rule is what stops `INSERT ...; DROP TABLE ...` from running as a single
 * tool call reported under the last command's tag. prepare stays off (the
 * postgres.js default for unsafe), so arbitrary agent SQL does not accumulate
 * named prepared statements on the server.
 */
function run(sql: postgres.Sql | postgres.TransactionSql, statement: string): postgres.PendingQuery<postgres.Row[]> {
  return sql.unsafe(statement, [], EXTENDED_PROTOCOL)
}

// postgres.js reads `simple` at runtime (src/index.js unsafe()) but leaves it
// out of UnsafeQueryOptions, which only declares `prepare`
const EXTENDED_PROTOCOL = { simple: false } as postgres.UnsafeQueryOptions

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
    // default_transaction_read_only is the backstop for the SQL parser in
    // utils.ts: even a statement that slips past it (a volatile function
    // behind a SELECT, say) is refused by the server on a read-only target
    connection: {
      application_name: 'tusk-mcp',
      default_transaction_read_only: options.readOnly,
    },
  })

  return {
    // pg_namespace instead of information_schema.schemata: the latter hides
    // schemas the connected role lacks CREATE/USAGE on, which would silently
    // drop their tables from the overview join for read-only roles.
    async listSchemas(): Promise<SchemaInfo[]> {
      const rows = await sql`
        SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
        FROM pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname NOT LIKE 'pg_temp_%'
          AND n.nspname NOT LIKE 'pg_toast_temp_%'
        ORDER BY n.nspname
      `
      return rows as unknown as SchemaInfo[]
    },

    async listTables(schema?: string): Promise<TableInfo[]> {
      const filter = schema ?? null
      const rows = await sql`
        SELECT
          s.schemaname AS schema,
          s.relname AS name,
          CASE c.relkind
            WHEN 'p' THEN 'partitioned table'
            WHEN 'm' THEN 'materialized view'
            ELSE 'table'
          END AS type,
          COALESCE(s.n_live_tup, 0) AS "estimatedRowCount"
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
        WHERE (${filter}::text IS NULL OR s.schemaname = ${filter})
          AND s.schemaname NOT LIKE 'pg_temp_%'
          AND c.oid NOT IN (SELECT inhrelid FROM pg_inherits)

        UNION ALL

        SELECT
          v.schemaname AS schema,
          v.viewname AS name,
          'view' AS type,
          0 AS "estimatedRowCount"
        FROM pg_views v
        WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
          AND v.schemaname NOT LIKE 'pg_temp_%'
          AND (${filter}::text IS NULL OR v.schemaname = ${filter})

        ORDER BY 1, 2
      `
      return rows.map(r => ({
        schema: r.schema as string,
        name: r.name as string,
        type: r.type as TableInfo['type'],
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
            a.attname AS "columnName",
            rn.nspname || '.' || rc.relname AS "referencedTable",
            ra.attname AS "referencedColumn",
            con.conname AS "constraintName"
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_class rc ON rc.oid = con.confrelid
          JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, refattnum) ON true
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = k.refattnum
          WHERE con.contype = 'f'
            AND n.nspname = ${schema}
            AND c.relname = ${table}
        `,
        sql`
          SELECT a.attname AS column_name
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p'
            AND n.nspname = ${schema}
            AND c.relname = ${table}
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
        }) as unknown as TableDescription['columns'],
        foreignKeys: foreignKeys.map(fk => ({
          columnName: fk.columnName as string,
          referencedTable: fk.referencedTable as string,
          referencedColumn: fk.referencedColumn as string,
          constraintName: fk.constraintName as string,
        })),
      }
    },

    async executeQuery(query: string, limit: number): Promise<QueryResult> {
      const cleaned = query.replace(/;\s*$/, '').trim()
      const fetchCount = limit + 1
      const firstWord = cleaned.split(/[\s(]/, 1)[0]?.toUpperCase()

      let rows: postgres.RowList<postgres.Row[]>
      // SHOW/EXPLAIN reject LIMIT in any form; run them raw and truncate below
      if (firstWord === 'SHOW' || firstWord === 'EXPLAIN') {
        rows = await readOnlyTransaction(sql, cleaned)
      } else {
        try {
          rows = await readOnlyTransaction(sql, `SELECT * FROM (${cleaned}) AS _tusk_result LIMIT ${fetchCount}`)
        } catch (wrappedErr) {
          try {
            // a fresh transaction, not a retry inside the aborted one
            rows = await readOnlyTransaction(sql, `${cleaned} LIMIT ${fetchCount}`)
          } catch {
            // the wrapped form's error describes the query as written, while
            // the fallback's may just complain about the appended LIMIT
            throw wrappedErr
          }
        }
      }

      const truncated = rows.length > limit
      const resultRows = truncated ? rows.slice(0, limit) : [...rows]
      const columns = rows.length > 0 ? Object.keys(rows[0]) : (rows.columns?.map(c => c.name) ?? [])

      return {
        columns,
        rows: resultRows as Record<string, unknown>[],
        rowCount: resultRows.length,
        truncated,
      }
    },

    // No LIMIT wrapping: a write statement's shape is the caller's, and
    // RETURNING output is truncated after the fact so the row count the
    // server reports stays the true number of affected rows
    async executeWrite(statement: string, limit: number): Promise<WriteResult> {
      const rows = await run(sql, statement.replace(/;\s*$/, '').trim())
      const columns = rows.columns?.map(c => c.name) ?? []
      // DDL reports no row count, a comment-only statement reports no command
      const affectedRows = rows.count ?? 0
      const command = rows.command ?? 'EMPTY'

      if (columns.length === 0) {
        return { command, affectedRows }
      }

      const truncated = rows.length > limit
      const returnedRows = truncated ? rows.slice(0, limit) : [...rows]
      return {
        command,
        affectedRows,
        returning: {
          columns,
          rows: returnedRows as Record<string, unknown>[],
          rowCount: returnedRows.length,
          truncated,
        },
      }
    },

    async close(): Promise<void> {
      await sql.end()
    },
  }
}
