# tusk-mcp

Postgres MCP server that gives an agent your local, stage and prod databases as named targets. Every query runs inside a READ ONLY transaction, so Postgres refuses a write the SQL check misses. Writes stay off until a target sets `access: "write"` in the config file. Databases behind a bastion connect through the built-in SSH tunnel or any proxy command: ssh, docker exec, kubectl exec. `compare-schemas` diffs a schema between any two targets.

## Install

```bash
npx tusk-mcp --host db.example.com --database mydb

# or clone + run
bun install
bun run src/index.ts --host localhost --database mydb
```

## Setup UI

Opens a browser form that tests the connection and writes the config for Claude Desktop, Claude Code, Cursor, Windsurf or OpenAI Codex.

```bash
npx tusk-mcp setup
```

## Build standalone binary

```bash
bun run build                            # host platform, dist/tusk-mcp
bun run build --target=bun-windows-x64   # cross-compile: bun-linux-arm64, bun-darwin-arm64, ...
```

## Connection

### Flags
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

## Multiple environments / databases

A config file defines named targets: environments (local/stage/prod) or entirely different databases within one app. `tusk.config.jsonc` or `tusk.config.json` in the working directory is picked up automatically when no connection flags are given; `--config <path>` (relative or absolute) loads an explicit file. Connection flags cannot be combined with a config file.

```jsonc
{
  "defaultTarget": "local",          // used when a tool call omits target
  "defaults": {                      // merged under every target
    "user": "app",
    "database": "myapp"
  },
  "targets": {
    "local": { "host": "localhost", "access": "write", "description": "dev" },
    "stage": {
      "host": "stage.db.internal",
      "password": "${STAGE_DB_PASSWORD}",   // env var interpolation
      "ssl": true
    },
    "prod": {
      "connectionString": "postgres://ro:${PROD_DB_PASSWORD}@10.0.0.5:5432/myapp",
      "ssh": { "host": "bastion.example.com", "user": "deploy", "key": "~/.ssh/id_rsa" },
      "access": "structure",                // schema visible, queries disabled
      "description": "production"
    },
    "analytics": { "host": "warehouse.db", "database": "events" }
  }
}
```

Target fields mirror the CLI flags: `host`, `port`, `user`, `password`, `passwordFile`, `passwordCmd`, `database`, `connectionString`, `ssl` (`true` or `{ca, cert, key}` paths), `ssh` (`{host, port, user, key, password}`), `proxyCommand`, `access`, `description`. `structureOnly: true` is still read as `access: "structure"`; setting both to different levels is a config error.

**Priority**: explicit fields > `connectionString` > `defaults`. `ssh`/`ssl` objects deep-merge, so `defaults.ssh` can hold the shared bastion and a target override just the port. `${VAR}` interpolates from the environment in any string, so the file is safe to commit. Config-file targets ignore `PG*` env vars; use `${PGPASSWORD}` explicitly if wanted.

With multiple targets every tool takes a `target` enum parameter (optional when `defaultTarget` is set, absent entirely with a single target), the target list is announced via MCP `instructions`, and `compare-schemas` becomes available. Connections are lazy per target: an unreachable bastion never blocks startup or the other targets.

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

## Proxy command

For databases behind something the built-in tunnel cannot express, a command's stdio can carry the connection, the way OpenSSH's `ProxyCommand` does. tusk listens on a loopback port and spawns one child per connection.

```bash
# your own ssh config, agent, and jump hosts, rather than tusk's ssh2 client
tusk-mcp --database mydb --proxy-command 'ssh bastion nc db.internal 5432'

# a database published nowhere, reachable only inside a container network
tusk-mcp --database mydb --proxy-command \
  'ssh swarm-node sudo docker run --rm -i --network app_net alpine/socat - TCP:postgres:5432'

# kubernetes, or anything else that speaks stdio
tusk-mcp --database mydb --proxy-command 'kubectl exec -i deploy/pg -- socat - TCP:localhost:5432'
```

In a config file it is the `proxyCommand` field. It and `ssh` both describe the hop to the database, so a target sets one; a target setting either replaces the other inherited from `defaults`. `host` and `port` are rejected alongside it, since the command reaches the database itself, while a `connectionString` on such a target still supplies user, password, and database.

The command is spawned once when the target connects, and a command that exits during that probe fails the tool call with its own stderr (`target "prod": proxyCommand exited 255: ssh: Could not resolve hostname ...`). After that it runs per connection, in its own process group so a piped command is killed whole. Three consecutive hops that carry no data stop the tunnel accepting for 30 seconds, since postgres.js reconnects without backoff.

## Access levels

Each target has one access level, `read` by default.

| `access` | Tools | Connection |
|---|---|---|
| `structure` | `overview`, `describe-tables` | read-only transactions |
| `read` | plus `execute-query` | read-only transactions |
| `write` | plus `execute-write` | writes allowed, through `execute-write` only |

```bash
tusk-mcp --host db --database mydb --structure-only   # every target: structure
tusk-mcp --host db --database mydb --allow-writes     # every target: write
```

The two flags are mutually exclusive. `--structure-only` also narrows a config file, but `--allow-writes` is rejected alongside one: escalating a target to writes has to be written in the file, where it is reviewable, rather than in an MCP client's command line.

`execute-query` cannot mutate on any target, write-enabled ones included: every query runs inside a `READ ONLY` transaction, so a `SELECT` that hides an `INSERT` behind a volatile function is refused by the server, not just by the SQL parser. `read` and `structure` connections additionally start with `default_transaction_read_only`. Writes therefore only ever happen through `execute-write`, which is registered only when some target allows them and whose `target` parameter lists write-enabled targets only.

`execute-write` takes one statement per call, reports the affected row count, and previews `RETURNING` rows. Beyond the target gate it does not filter SQL: on a write target the database role is the boundary, so give that role only the privileges the agent should have.

## Tools

| Tool | Description |
|---|---|
| `overview` | All schemas with tables, views, and estimated row counts in one call (partitions filtered out) |
| `describe-tables` | Columns, types, PKs, FKs, and enum values for one or more tables per call |
| `execute-query` | Read-only SQL with limit (rejected on structure-only targets) |
| `execute-write` | One mutating statement with affected rows and `RETURNING` preview (write-enabled targets only) |
| `compare-schemas` | Structural diff of a schema between two targets (multi-target only) |

## Output format

Tool results use compact text in `content` for the AI model and JSON-safe
preview data in `structuredContent` for clients that support structured MCP
output. Query text uses a tab-delimited preview with `null=\N`; strings are
JSON-quoted, so empty strings render as `""` and the literal string `"\\N"` is
distinct from SQL null. With multiple targets, results start with a
`target=<name>` line.

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
| `--config` | string | - | Multi-target config file (see above) |
| `--host` | string | localhost | PostgreSQL host |
| `--port` | number | 5432 | PostgreSQL port |
| `--user` | string | - | Database user |
| `--password` | string | - | Database password |
| `--password-file` | string | - | Read password from file |
| `--password-cmd` | string | - | Run command for password |
| `--database` | string | - | Database name |
| `--connection-string` | string | - | Full connection URL |
| `--ssl` | boolean | false | Enable SSL without certificate verification |
| `--ssl-ca` | string | - | CA certificate path (enables SSL) |
| `--ssl-cert` | string | - | Client certificate path (enables SSL) |
| `--ssl-key` | string | - | Client key path (enables SSL) |
| `--ssh-host` | string | - | SSH tunnel host |
| `--ssh-port` | number | 22 | SSH tunnel port |
| `--ssh-user` | string | - | SSH username |
| `--ssh-key` | string | - | SSH private key path |
| `--ssh-password` | string | - | SSH password |
| `--proxy-command` | string | - | Shell command whose stdio carries the connection |
| `--structure-only` | boolean | false | Schema only, no `execute-query` |
| `--allow-writes` | boolean | false | Add `execute-write` (no config file) |
