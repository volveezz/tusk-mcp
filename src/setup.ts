import http from 'http'
import { exec, spawn } from 'child_process'
import { readFile, writeFile, access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import net from 'net'
import { createPostgresClient } from './client.js'
import { createTunnel } from './tunnel.js'
import { parseConnectionString } from './utils.js'
import type { PostgresConnectionOptions, Tunnel } from './types.js'

async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: string) => (data += chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(data)) }
      catch { reject(new Error('Invalid JSON')) }
    })
  })
}

async function testConnection(params: Record<string, unknown>) {
  let tunnel: Tunnel | undefined
  try {
    const connOptions: PostgresConnectionOptions = {
      host: (params.host as string) || 'localhost',
      port: parseInt(String(params.port)) || 5432,
      user: (params.user as string) || undefined,
      password: (params.password as string) || undefined,
      database: (params.database as string) || undefined,
    }

    if (params.connectionString) {
      const parsed = parseConnectionString(params.connectionString as string)
      connOptions.host = parsed.host
      connOptions.port = parsed.port
      connOptions.user = parsed.user
      connOptions.password = parsed.password
      connOptions.database = parsed.database
    }

    if (params.ssl || params.sslCa || params.sslCert || params.sslKey) {
      const sslConfig: Record<string, unknown> = {}
      if (params.sslCa) {
        sslConfig.rejectUnauthorized = true
        sslConfig.ca = await readFile(params.sslCa as string, 'utf-8')
      } else {
        sslConfig.rejectUnauthorized = false
      }
      if (params.sslCert) sslConfig.cert = await readFile(params.sslCert as string, 'utf-8')
      if (params.sslKey) sslConfig.key = await readFile(params.sslKey as string, 'utf-8')
      connOptions.ssl = sslConfig
    }

    if (params.sshHost) {
      tunnel = await createTunnel({
        sshHost: params.sshHost as string,
        sshPort: parseInt(String(params.sshPort)) || 22,
        sshUser: params.sshUser as string,
        sshKey: (params.sshKey as string) || undefined,
        sshPassword: (params.sshPassword as string) || undefined,
        targetHost: connOptions.host,
        targetPort: connOptions.port,
      })
      connOptions.host = tunnel.localHost
      connOptions.port = tunnel.localPort
    }

    const client = createPostgresClient(connOptions)
    const result = await client.executeQuery(
      "SELECT current_database() AS db, version() AS version, current_user AS usr", 1
    )
    await client.close()
    const row = result.rows[0] || {}
    return { success: true, info: { db: row.db, version: row.version, user: row.usr } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (tunnel) await tunnel.close().catch(() => {})
  }
}

interface ConfigTarget {
  label: string
  path: string
  exists: boolean
}

async function getConfigPaths(): Promise<ConfigTarget[]> {
  const home = homedir()
  const targets: { label: string; path: string }[] = []

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    targets.push({ label: 'Claude Desktop', path: join(appData, 'Claude', 'claude_desktop_config.json') })
  } else if (process.platform === 'darwin') {
    targets.push({ label: 'Claude Desktop', path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') })
  } else {
    targets.push({ label: 'Claude Desktop', path: join(home, '.config', 'Claude', 'claude_desktop_config.json') })
  }

  targets.push(
    { label: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
    { label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { label: 'Claude Code (global)', path: join(home, '.claude', 'settings.local.json') },
  )

  const results: ConfigTarget[] = []
  for (const t of targets) {
    const exists = await access(t.path).then(() => true).catch(() => false)
    results.push({ ...t, exists })
  }
  return results
}

/**
 * Merges tusk MCP server config into an existing config file.
 * Creates the file if it doesn't exist. Preserves all other servers.
 * Refuses to overwrite files with invalid JSON to prevent data loss.
 */
async function saveConfig(filePath: string, tuskConfig: Record<string, unknown>) {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(filePath, 'utf-8')
    existing = JSON.parse(raw)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      existing = {}
    } else if (err instanceof SyntaxError) {
      throw new Error('Existing config file contains invalid JSON — fix it manually before saving')
    } else {
      throw new Error(`Cannot read config: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (existing.mcpServers !== undefined && (typeof existing.mcpServers !== 'object' || Array.isArray(existing.mcpServers))) {
    throw new Error('Existing config has invalid mcpServers field — expected an object')
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) || {}
  mcpServers.tusk = tuskConfig
  existing.mcpServers = mcpServers

  const { mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

function openSaveDialog(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = [
        '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.TopMost = $true',
        '$d = New-Object System.Windows.Forms.SaveFileDialog',
        `$d.Title = "${title.replace(/"/g, '`"')}"`,
        "$d.Filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*'",
        '$d.DefaultExt = "json"',
        'if ($d.ShowDialog($f) -eq "OK") { $d.FileName }',
        '$f.Dispose()',
      ].join('\n')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      exec(`powershell -STA -NoProfile -EncodedCommand ${encoded}`, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null)
      })
      return
    }

    if (process.platform === 'darwin') {
      const proc = spawn('osascript', [
        '-e', `POSIX path of (choose file name with prompt ${JSON.stringify(title)} default name "mcp_config.json")`,
      ])
      let out = ''
      proc.stdout?.on('data', (c: Buffer) => { out += c.toString() })
      proc.on('error', () => resolve(null))
      proc.on('close', () => resolve(out.trim() || null))
      return
    }

    const zenity = spawn('zenity', ['--file-selection', '--save', `--title=${title}`, '--filename=mcp_config.json'])
    let out = ''
    zenity.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    zenity.on('error', () => resolve(null))
    zenity.on('close', () => resolve(out.trim() || null))
  })
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin' ? `open ${url}`
    : `xdg-open ${url}`
  exec(cmd, () => {})
}

/**
 * Opens a native OS file picker dialog asynchronously.
 * Windows: PowerShell with -EncodedCommand (base64) to avoid MSYS pipe/shell issues.
 * macOS: osascript. Linux: zenity or kdialog.
 */
function openFileDialog(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = [
        '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.TopMost = $true',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        `$d.Title = "${title.replace(/"/g, '`"')}"`,
        'if ($d.ShowDialog($f) -eq "OK") { $d.FileName }',
        '$f.Dispose()',
      ].join('\n')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      exec(`powershell -STA -NoProfile -EncodedCommand ${encoded}`, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null)
      })
      return
    }

    if (process.platform === 'darwin') {
      const proc = spawn('osascript', [
        '-e', `POSIX path of (choose file with prompt ${JSON.stringify(title)})`,
      ])
      let out = ''
      proc.stdout?.on('data', (c: Buffer) => { out += c.toString() })
      proc.on('error', () => resolve(null))
      proc.on('close', () => resolve(out.trim() || null))
      return
    }

    const zenity = spawn('zenity', ['--file-selection', `--title=${title}`])
    let out = ''
    zenity.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    zenity.on('error', () => {
      const kd = spawn('kdialog', ['--getopenfilename', '~', '--title', title])
      let ko = ''
      kd.stdout?.on('data', (c: Buffer) => { ko += c.toString() })
      kd.on('error', () => resolve(null))
      kd.on('close', () => resolve(ko.trim() || null))
    })
    zenity.on('close', (code) => {
      if (code === 0 && out.trim()) { resolve(out.trim()); return }
      const kd = spawn('kdialog', ['--getopenfilename', '~', '--title', title])
      let ko = ''
      kd.stdout?.on('data', (c: Buffer) => { ko += c.toString() })
      kd.on('error', () => resolve(null))
      kd.on('close', () => resolve(ko.trim() || null))
    })
  })
}

export async function startSetup() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }

    if (req.url === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/api/browse') {
      try {
        const params = await parseBody(req)
        const title = (params.title as string) || 'Select file'
        const filePath = await openFileDialog(title)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: filePath }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: null }))
      }
      return
    }

    if (req.method === 'POST' && req.url === '/api/test') {
      try {
        const params = await parseBody(req)
        const result = await testConnection(params)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }))
      }
      return
    }

    if (req.method === 'GET' && req.url === '/api/config-paths') {
      try {
        const paths = await getConfigPaths()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(paths))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([]))
      }
      return
    }

    if (req.method === 'POST' && req.url === '/api/save-config') {
      try {
        const params = await parseBody(req)
        const filePath = params.path as string
        const tuskConfig = params.tuskConfig as Record<string, unknown>
        if (!filePath || !tuskConfig) throw new Error('Missing path or config')
        await saveConfig(filePath, tuskConfig)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, path: filePath }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    if (req.method === 'POST' && req.url === '/api/save-dialog') {
      try {
        const filePath = await openSaveDialog('Save MCP Configuration')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: filePath }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: null }))
      }
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `http://127.0.0.1:${port}`

  console.log(`\n  tusk-mcp setup running at ${url}\n`)
  openBrowser(url)

  await new Promise(() => {})
}

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>tusk-mcp setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #09090b; --surface: #18181b; --surface-2: #1e1e22;
    --border: #27272a; --border-focus: #3b82f6;
    --text: #fafafa; --text-muted: #a1a1aa; --text-dim: #71717a;
    --primary: #3b82f6; --primary-hover: #2563eb;
    --success: #22c55e; --success-bg: #052e16;
    --error: #ef4444; --error-bg: #450a0a;
    --radius: 8px; --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }

  body {
    font-family: var(--font); font-size: 14px; color: var(--text);
    background: var(--bg); line-height: 1.5;
    min-height: 100vh; padding: 40px 16px 80px;
  }

  .container { max-width: 580px; margin: 0 auto; }

  header { margin-bottom: 32px; }
  header h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.025em; }
  header p { color: var(--text-muted); margin-top: 4px; }

  section { margin-bottom: 20px; }

  .section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 0; cursor: pointer; user-select: none;
    color: var(--text-muted); font-size: 13px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .section-header:hover { color: var(--text); }
  .section-header .arrow { transition: transform 0.2s; font-size: 10px; }
  .section-header.open .arrow { transform: rotate(90deg); }
  .section-content { display: none; padding-bottom: 4px; }
  .section-content.open { display: block; }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px;
  }

  .field { margin-bottom: 14px; }
  .field:last-child { margin-bottom: 0; }
  .field label {
    display: block; font-size: 13px; font-weight: 500;
    color: var(--text-muted); margin-bottom: 5px;
  }

  .row { display: flex; gap: 12px; }
  .row > .field { flex: 1; }

  input[type="text"], input[type="number"], input[type="password"] {
    width: 100%; padding: 8px 10px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-family: var(--font);
    font-size: 14px; outline: none; transition: border-color 0.15s;
  }
  input:focus { border-color: var(--border-focus); }
  input::placeholder { color: var(--text-dim); }

  .toggle-row {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
  }
  .toggle-row label { margin-bottom: 0; font-size: 14px; color: var(--text); cursor: pointer; }
  input[type="checkbox"] {
    width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer;
  }

  .file-row { display: flex; gap: 8px; }
  .file-row input { flex: 1; min-width: 0; }
  .browse-btn {
    padding: 8px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;
    background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border);
    cursor: pointer; font-family: var(--font); transition: all 0.15s;
    white-space: nowrap; flex-shrink: 0;
  }
  .browse-btn:hover { background: #2a2a2e; color: var(--text); border-color: #3f3f46; }

  .mode-tabs {
    display: flex; gap: 0; margin-bottom: 16px;
    background: var(--bg); border-radius: 6px; padding: 3px;
    border: 1px solid var(--border);
  }
  .mode-tab {
    flex: 1; padding: 7px 0; text-align: center; cursor: pointer;
    border-radius: 4px; font-size: 13px; font-weight: 500;
    color: var(--text-muted); transition: all 0.15s; border: none; background: none;
  }
  .mode-tab.active { background: var(--surface-2); color: var(--text); }
  .mode-tab:hover:not(.active) { color: var(--text); }

  .actions { display: flex; gap: 10px; margin: 24px 0; }

  .btn {
    padding: 9px 18px; border-radius: 6px; font-size: 14px; font-weight: 500;
    cursor: pointer; border: none; font-family: var(--font); transition: all 0.15s;
  }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .result-box {
    border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px;
    font-size: 13px; display: none;
  }
  .result-box.success { display: block; background: var(--success-bg); border: 1px solid #166534; color: #bbf7d0; }
  .result-box.error { display: block; background: var(--error-bg); border: 1px solid #991b1b; color: #fca5a5; }
  .result-box .result-title { font-weight: 600; margin-bottom: 4px; }
  .result-box pre { white-space: pre-wrap; word-break: break-all; margin-top: 6px; font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace; font-size: 12px; }

  .config-section { margin-top: 28px; }
  .config-section h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
  .config-block {
    position: relative; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px; margin-bottom: 12px;
  }
  .config-block pre {
    white-space: pre-wrap; word-break: break-all;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    font-size: 12.5px; line-height: 1.6; color: var(--text-muted);
  }
  .config-label {
    font-size: 12px; font-weight: 500; color: var(--text-dim);
    margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .copy-btn {
    position: absolute; top: 10px; right: 10px;
    padding: 5px 10px; border-radius: 4px; font-size: 12px;
    background: var(--border); color: var(--text-muted); border: none;
    cursor: pointer; font-family: var(--font); transition: all 0.15s;
  }
  .copy-btn:hover { background: #3f3f46; color: var(--text); }

  .save-section { margin-top: 28px; }
  .save-section h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }

  .save-targets { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .save-target {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; cursor: pointer; transition: all 0.15s;
  }
  .save-target:hover { border-color: #3f3f46; }
  .save-target.selected { border-color: var(--primary); background: #111827; }
  .save-target input[type="radio"] { accent-color: var(--primary); cursor: pointer; }
  .save-target .target-label { font-size: 14px; font-weight: 500; }
  .save-target .target-path {
    font-size: 12px; color: var(--text-dim); margin-top: 2px;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    word-break: break-all;
  }
  .save-target .target-badge {
    font-size: 11px; padding: 2px 6px; border-radius: 3px;
    margin-left: auto; flex-shrink: 0;
  }
  .target-badge.exists { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .target-badge.new { background: #172554; color: #93c5fd; border: 1px solid #1e40af; }

  .save-actions { display: flex; gap: 10px; align-items: center; }
  .btn-success { background: #16a34a; color: #fff; }
  .btn-success:hover { background: #15803d; }
  .btn-success:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    padding: 9px 18px; border-radius: 6px; font-size: 14px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border); font-family: var(--font);
    background: var(--surface); color: var(--text-muted); transition: all 0.15s;
  }
  .btn-secondary:hover { background: var(--surface-2); color: var(--text); }

  .save-result {
    margin-top: 12px; padding: 12px 14px; border-radius: 6px;
    font-size: 13px; display: none;
  }
  .save-result.success { display: block; background: var(--success-bg); border: 1px solid #166534; color: #bbf7d0; }
  .save-result.error { display: block; background: var(--error-bg); border: 1px solid #991b1b; color: #fca5a5; }

  .spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    border-radius: 50%; animation: spin 0.6s linear infinite;
    vertical-align: middle; margin-right: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>tusk-mcp</h1>
    <p>PostgreSQL MCP Server &mdash; Connection Setup</p>
  </header>

  <form autocomplete="off" onsubmit="return false">
  <section>
    <div class="mode-tabs">
      <button type="button" class="mode-tab active" data-mode="fields">Individual Fields</button>
      <button type="button" class="mode-tab" data-mode="string">Connection String</button>
    </div>

    <div class="card">
      <div id="fields-mode">
        <div class="row">
          <div class="field">
            <label>Host</label>
            <input type="text" id="host" value="localhost" placeholder="localhost">
          </div>
          <div class="field" style="max-width: 120px">
            <label>Port</label>
            <input type="number" id="port" value="5432" placeholder="5432">
          </div>
        </div>
        <div class="field">
          <label>Database</label>
          <input type="text" id="database" placeholder="mydb">
        </div>
        <div class="row">
          <div class="field">
            <label>User</label>
            <input type="text" id="user" placeholder="postgres">
          </div>
          <div class="field">
            <label>Password</label>
            <input type="password" id="password" placeholder="optional">
          </div>
        </div>
      </div>

      <div id="string-mode" style="display:none">
        <div class="field">
          <label>Connection String</label>
          <input type="text" id="connectionString" placeholder="postgresql://user:pass@host:5432/db">
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-header" data-toggle="ssl-section">
      <span class="arrow">&#9654;</span> SSL Configuration
    </div>
    <div class="section-content card" id="ssl-section">
      <div class="field">
        <label>CA Certificate</label>
        <div class="file-row">
          <input type="text" id="sslCa" placeholder="/path/to/ca.crt">
          <button type="button" class="browse-btn" data-target="sslCa" data-title="Select CA Certificate">Browse</button>
        </div>
      </div>
      <div class="field">
        <label>Client Certificate</label>
        <div class="file-row">
          <input type="text" id="sslCert" placeholder="/path/to/client.crt">
          <button type="button" class="browse-btn" data-target="sslCert" data-title="Select Client Certificate">Browse</button>
        </div>
      </div>
      <div class="field">
        <label>Client Key</label>
        <div class="file-row">
          <input type="text" id="sslKey" placeholder="/path/to/client.key">
          <button type="button" class="browse-btn" data-target="sslKey" data-title="Select Client Key">Browse</button>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-header" data-toggle="ssh-section">
      <span class="arrow">&#9654;</span> SSH Tunnel
    </div>
    <div class="section-content card" id="ssh-section">
      <div class="row">
        <div class="field">
          <label>SSH Host</label>
          <input type="text" id="sshHost" placeholder="bastion.example.com">
        </div>
        <div class="field" style="max-width: 120px">
          <label>SSH Port</label>
          <input type="number" id="sshPort" value="22" placeholder="22">
        </div>
      </div>
      <div class="field">
        <label>SSH User</label>
        <input type="text" id="sshUser" placeholder="deploy">
      </div>
      <div class="field">
        <label>SSH Private Key</label>
        <div class="file-row">
          <input type="text" id="sshKey" placeholder="~/.ssh/id_rsa">
          <button type="button" class="browse-btn" data-target="sshKey" data-title="Select SSH Private Key">Browse</button>
        </div>
      </div>
      <div class="field">
        <label>SSH Password</label>
        <input type="password" id="sshPassword" placeholder="optional (alternative to key)">
      </div>
    </div>
  </section>

  <section>
    <div class="section-header" data-toggle="options-section">
      <span class="arrow">&#9654;</span> Options
    </div>
    <div class="section-content card" id="options-section">
      <div class="toggle-row">
        <input type="checkbox" id="structureOnly">
        <label for="structureOnly">Schema-only mode &mdash; prevent AI agents from running SQL queries</label>
      </div>
    </div>
  </section>

  <div class="actions">
    <button type="button" class="btn btn-primary" id="testBtn">Test Connection</button>
  </div>
  </form>

  <div class="result-box" id="resultBox">
    <div class="result-title" id="resultTitle"></div>
    <pre id="resultBody"></pre>
  </div>

  <div class="config-section">
    <h2>MCP Configuration</h2>
    <div class="config-block">
      <div class="config-label">JSON Config (Claude Desktop / Cursor / Windsurf)</div>
      <button class="copy-btn" data-target="configJson">Copy</button>
      <pre id="configJson"></pre>
    </div>
    <div class="config-block">
      <div class="config-label">Claude Code</div>
      <button class="copy-btn" data-target="configClaudeCode">Copy</button>
      <pre id="configClaudeCode"></pre>
    </div>
    <div class="config-block">
      <div class="config-label">OpenAI Codex (~/.codex/config.toml)</div>
      <button class="copy-btn" data-target="configCodex">Copy</button>
      <pre id="configCodex"></pre>
    </div>
    <div class="config-block">
      <div class="config-label">CLI</div>
      <button class="copy-btn" data-target="configCli">Copy</button>
      <pre id="configCli"></pre>
    </div>
  </div>

  <div class="save-section">
    <h2>Save to Config File</h2>
    <div class="save-targets" id="saveTargets">
      <div style="color: var(--text-dim); font-size: 13px; padding: 8px 0;">Loading config locations...</div>
    </div>
    <div class="save-actions">
      <button type="button" class="btn btn-success" id="saveBtn" disabled>Save Configuration</button>
      <button type="button" class="btn btn-secondary" id="saveBrowseBtn">Save to other location...</button>
    </div>
    <div class="save-result" id="saveResult"></div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s)
const $$ = (s) => document.querySelectorAll(s)

// Mode tabs
$$('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.mode-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const mode = tab.dataset.mode
    $('#fields-mode').style.display = mode === 'fields' ? 'block' : 'none'
    $('#string-mode').style.display = mode === 'string' ? 'block' : 'none'
    updateConfig()
  })
})

// Collapsible sections
$$('.section-header').forEach(header => {
  header.addEventListener('click', () => {
    const id = header.dataset.toggle
    const content = document.getElementById(id)
    header.classList.toggle('open')
    content.classList.toggle('open')
  })
})

// Copy buttons
$$('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target)
    navigator.clipboard.writeText(target.textContent).then(() => {
      const orig = btn.textContent
      btn.textContent = 'Copied!'
      setTimeout(() => btn.textContent = orig, 1500)
    })
  })
})

// Browse buttons — open native file picker via server endpoint
$$('.browse-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetId = btn.dataset.target
    const title = btn.dataset.title || 'Select file'
    btn.disabled = true
    btn.textContent = '...'
    try {
      const res = await fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const data = await res.json()
      if (data.path) {
        document.getElementById(targetId).value = data.path
        updateConfig()
      }
    } catch {}
    btn.disabled = false
    btn.textContent = 'Browse'
  })
})

function getParams() {
  const isString = $('.mode-tab.active').dataset.mode === 'string'
  const p = {}
  if (isString) {
    p.connectionString = $('#connectionString').value
  } else {
    if ($('#host').value) p.host = $('#host').value
    if ($('#port').value) p.port = $('#port').value
    if ($('#database').value) p.database = $('#database').value
    if ($('#user').value) p.user = $('#user').value
    if ($('#password').value) p.password = $('#password').value
  }
  if ($('#sslCa').value) p.sslCa = $('#sslCa').value
  if ($('#sslCert').value) p.sslCert = $('#sslCert').value
  if ($('#sslKey').value) p.sslKey = $('#sslKey').value
  if (p.sslCa || p.sslCert || p.sslKey) p.ssl = true
  if ($('#sshHost').value) p.sshHost = $('#sshHost').value
  if ($('#sshPort').value && $('#sshPort').value !== '22') p.sshPort = $('#sshPort').value
  if ($('#sshUser').value) p.sshUser = $('#sshUser').value
  if ($('#sshKey').value) p.sshKey = $('#sshKey').value
  if ($('#sshPassword').value) p.sshPassword = $('#sshPassword').value
  if ($('#structureOnly').checked) p.structureOnly = true
  return p
}

function buildArgs(p) {
  const args = []
  if (p.connectionString) {
    args.push('--connection-string', p.connectionString)
  } else {
    if (p.host && p.host !== 'localhost') args.push('--host', p.host)
    if (p.port && p.port !== '5432') args.push('--port', p.port)
    if (p.database) args.push('--database', p.database)
    if (p.user) args.push('--user', p.user)
  }
  if (p.sslCa) args.push('--ssl-ca', p.sslCa)
  if (p.sslCert) args.push('--ssl-cert', p.sslCert)
  if (p.sslKey) args.push('--ssl-key', p.sslKey)
  if (p.sshHost) args.push('--ssh-host', p.sshHost)
  if (p.sshPort) args.push('--ssh-port', p.sshPort)
  if (p.sshUser) args.push('--ssh-user', p.sshUser)
  if (p.sshKey) args.push('--ssh-key', p.sshKey)
  if (p.structureOnly) args.push('--structure-only')
  return args
}

function updateConfig() {
  const p = getParams()
  const args = buildArgs(p)

  const env = {}
  if (p.password) env.PGPASSWORD = p.password
  if (p.sshPassword) env.SSH_PASSWORD = p.sshPassword

  const hasEnv = Object.keys(env).length > 0
  const mcpArgs = ['-y', 'tusk-mcp', ...args]

  const config = { mcpServers: { tusk: { command: 'npx', args: mcpArgs } } }
  if (hasEnv) config.mcpServers.tusk.env = env

  $('#configJson').textContent = JSON.stringify(config, null, 2)

  // Claude Code: claude mcp add --transport stdio ...
  const envFlags = Object.entries(env).map(([k, v]) => '--env ' + k + '=' + v).join(' ')
  const claudeArgs = args.map(a => a.includes(' ') ? "'" + a + "'" : a).join(' ')
  let claudeCode = 'claude mcp add --transport stdio'
  if (envFlags) claudeCode += ' ' + envFlags
  claudeCode += ' tusk -- npx -y tusk-mcp'
  if (claudeArgs) claudeCode += ' ' + claudeArgs
  $('#configClaudeCode').textContent = claudeCode

  // OpenAI Codex: ~/.codex/config.toml
  let toml = '[mcp_servers.tusk]\n'
  toml += 'command = "npx"\n'
  toml += 'args = ' + JSON.stringify(['-y', 'tusk-mcp', ...args]) + '\n'
  if (hasEnv) {
    toml += '\n[mcp_servers.tusk.env]\n'
    for (const [k, v] of Object.entries(env)) {
      toml += k + ' = "' + v.replace(/"/g, '\\"') + '"\n'
    }
  }
  $('#configCodex').textContent = toml.trimEnd()

  // CLI command
  let cli = 'npx -y tusk-mcp'
  if (args.length) cli += ' ' + args.map(a => a.includes(' ') ? "'" + a + "'" : a).join(' ')
  if (p.password) cli = 'PGPASSWORD=*** ' + cli
  $('#configCli').textContent = cli
}

// Test connection
$('#testBtn').addEventListener('click', async () => {
  const btn = $('#testBtn')
  const box = $('#resultBox')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Testing...'
  box.className = 'result-box'

  try {
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getParams()),
    })
    const data = await res.json()

    if (data.success) {
      box.className = 'result-box success'
      $('#resultTitle').textContent = 'Connection successful'
      $('#resultBody').textContent = data.info.db + ' \\u2014 ' + (data.info.version || '').split(',')[0]
        + '\\nUser: ' + data.info.user
    } else {
      box.className = 'result-box error'
      $('#resultTitle').textContent = 'Connection failed'
      $('#resultBody').textContent = data.error
    }
  } catch (err) {
    box.className = 'result-box error'
    $('#resultTitle').textContent = 'Request failed'
    $('#resultBody').textContent = err.message
  } finally {
    btn.disabled = false
    btn.textContent = 'Test Connection'
  }
})

// Update config on any input change
$$('input').forEach(el => el.addEventListener('input', updateConfig))
$$('input[type="checkbox"]').forEach(el => el.addEventListener('change', updateConfig))

updateConfig()

// --- Save to config file ---
let selectedSavePath = null

function getTuskServerConfig() {
  const p = getParams()
  const args = buildArgs(p)
  const config = { command: 'npx', args: ['-y', 'tusk-mcp', ...args] }
  const env = {}
  if (p.password) env.PGPASSWORD = p.password
  if (p.sshPassword) env.SSH_PASSWORD = p.sshPassword
  if (Object.keys(env).length) config.env = env
  return config
}

async function loadConfigTargets() {
  try {
    const res = await fetch('/api/config-paths')
    const targets = await res.json()
    const container = $('#saveTargets')
    container.innerHTML = ''

    targets.forEach((t, i) => {
      const div = document.createElement('div')
      div.className = 'save-target'
      div.innerHTML =
        '<input type="radio" name="saveTarget" value="' + t.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '&quot;') + '" id="target' + i + '">' +
        '<div>' +
          '<div class="target-label"><label for="target' + i + '" style="cursor:pointer">' + t.label + '</label></div>' +
          '<div class="target-path">' + t.path + '</div>' +
        '</div>' +
        '<span class="target-badge ' + (t.exists ? 'exists' : 'new') + '">' + (t.exists ? 'update' : 'create') + '</span>'

      div.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return
        div.querySelector('input').checked = true
        onTargetSelect(t.path)
      })
      div.querySelector('input').addEventListener('change', () => onTargetSelect(t.path))
      container.appendChild(div)
    })
  } catch {}
}

function onTargetSelect(path) {
  selectedSavePath = path
  $('#saveBtn').disabled = false
  $$('.save-target').forEach(el => {
    const radio = el.querySelector('input')
    el.classList.toggle('selected', radio.checked)
  })
}

async function doSave(path) {
  const btn = $('#saveBtn')
  const result = $('#saveResult')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Saving...'
  result.className = 'save-result'

  try {
    const res = await fetch('/api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, tuskConfig: getTuskServerConfig() }),
    })
    const data = await res.json()
    if (data.success) {
      result.className = 'save-result success'
      result.textContent = 'Saved to ' + data.path
      loadConfigTargets()
    } else {
      result.className = 'save-result error'
      result.textContent = data.error
    }
  } catch (err) {
    result.className = 'save-result error'
    result.textContent = err.message
  } finally {
    btn.disabled = !selectedSavePath
    btn.textContent = 'Save Configuration'
  }
}

let saveInProgress = false
$('#saveBtn').addEventListener('click', async () => {
  if (saveInProgress || !selectedSavePath) return
  saveInProgress = true
  await doSave(selectedSavePath)
  saveInProgress = false
})

$('#saveBrowseBtn').addEventListener('click', async () => {
  const btn = $('#saveBrowseBtn')
  btn.disabled = true
  btn.textContent = '...'
  try {
    const res = await fetch('/api/save-dialog', { method: 'POST' })
    const data = await res.json()
    if (data.path) {
      await doSave(data.path)
    }
  } catch {}
  btn.disabled = false
  btn.textContent = 'Save to other location...'
})

loadConfigTargets()
</script>
</body>
</html>`
