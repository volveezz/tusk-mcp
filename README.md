# tusk-mcp

Read-only PostgreSQL MCP server for AI agents. Exposes schema introspection and SELECT-only query execution over the Model Context Protocol.

## Install

```bash
# npx (no install needed)
npx tusk-mcp --host db.example.com --database mydb

# or clone + run
bun install
bun run src/index.ts --host localhost --database mydb
```

## Setup UI

Interactive browser-based setup that generates config for Claude Desktop, Claude Code, Cursor, Windsurf, and OpenAI Codex.

```bash
npx tusk-mcp setup
```

## Build standalone binary

```bash
bun run build           # Windows
bun run build:linux     # Linux
bun run build:macos     # macOS ARM
```

## Connection

### Individual flags (recommended)
```bash
tusk-mcp --host db.example.com --port 5432 --user admin --password 'p@ss' --database mydb
```

### Connection string
```bash
tusk-mcp --connection-string "postgres://admin:p%40ss@db.example.com:5432/mydb"
```

Unencoded special characters in passwords (`@`, `#`) are handled automatically.

### Environment variables
```bash
PGHOST=db.example.com PGDATABASE=mydb tusk-mcp
```

**Priority**: flags > `--connection-string` > `DATABASE_URL` > `PG*` env vars

## Password security

```bash
# From file (Docker/K8s secrets)
tusk-mcp --host db --database mydb --password-file /run/secrets/db_pass

# From command (any secrets manager)
tusk-mcp --host db --database mydb --password-cmd 'vault kv get -field=password secret/db'
tusk-mcp --host db --database mydb --password-cmd 'op read op://vault/db/password'
```

## SSL

Providing any certificate file automatically enables SSL.

```bash
tusk-mcp --host db --database mydb --ssl-ca /path/to/ca.crt       # CA verification
tusk-mcp --host db --database mydb \                               # mutual TLS
  --ssl-ca ca.crt --ssl-cert client.crt --ssl-key client.key
```

## SSH tunnel

```bash
tusk-mcp --host db-internal --database mydb \
  --ssh-host bastion.example.com --ssh-user deploy --ssh-key ~/.ssh/id_rsa
```

## Structure-only mode

Disables `execute-query` tool. Agents can see schema but not run queries.

```bash
tusk-mcp --host db --database mydb --structure-only
```

## Tools

| Tool | Description |
|---|---|
| `list-schemas` | List non-system schemas |
| `list-tables` | Tables and views with estimated row counts (partitions filtered out) |
| `describe-table` | Columns, types, PKs, FKs, and enum values inline |
| `execute-query` | Read-only SQL with limit (disabled in structure-only mode) |

## MCP config

```json
{
  "mcpServers": {
    "tusk": {
      "command": "npx",
      "args": ["-y", "tusk-mcp", "--host", "localhost", "--database", "mydb"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio tusk -- npx -y tusk-mcp --host localhost --database mydb
```

### OpenAI Codex (~/.codex/config.toml)

```toml
[mcp_servers.tusk]
command = "npx"
args = ["-y", "tusk-mcp", "--host", "localhost", "--database", "mydb"]
```

## All flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--host` | string | localhost | PostgreSQL host |
| `--port` | number | 5432 | PostgreSQL port |
| `--user` | string | — | Database user |
| `--password` | string | — | Database password |
| `--password-file` | string | — | Read password from file |
| `--password-cmd` | string | — | Run command for password |
| `--database` | string | — | Database name |
| `--connection-string` | string | — | Full connection URL |
| `--ssl-ca` | string | — | CA certificate path (enables SSL) |
| `--ssl-cert` | string | — | Client certificate path (enables SSL) |
| `--ssl-key` | string | — | Client key path (enables SSL) |
| `--ssh-host` | string | — | SSH tunnel host |
| `--ssh-port` | number | 22 | SSH tunnel port |
| `--ssh-user` | string | — | SSH username |
| `--ssh-key` | string | — | SSH private key path |
| `--ssh-password` | string | — | SSH password |
| `--structure-only` | boolean | false | Disable execute-query |
