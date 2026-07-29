/**
 * Config resolution: tusk.config.jsonc|json (cwd auto-discovery or --config)
 * with named targets + defaults + ${ENV_VAR} interpolation, or a single
 * unnamed target built from CLI flags / DATABASE_URL / PG* env vars.
 * TargetConfig/TuskConfig types are inferred from the zod schemas here.
 * Consumed by index.ts; targets connect lazily in targets.ts.
 */
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import { parseConnectionString } from './utils.js'
import type { ConnectionFlags } from './types.js'

const CONFIG_FILENAMES = ['tusk.config.jsonc', 'tusk.config.json']

const sslFilesSchema = z.object({
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
}).strict()

// ssh fields are optional at parse time so a target can override part of a
// defaults.ssh block; completeness is enforced post-merge in parseConfig
const sshSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().optional(),
  user: z.string().optional(),
  key: z.string().optional(),
  password: z.string().optional(),
}).strict()

const targetSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  passwordFile: z.string().optional(),
  passwordCmd: z.string().optional(),
  database: z.string().optional(),
  connectionString: z.string().optional(),
  ssl: z.union([z.boolean(), sslFilesSchema]).optional(),
  ssh: sshSchema.optional(),
  structureOnly: z.boolean().optional(),
  description: z.string().optional(),
}).strict()

const configFileSchema = z.object({
  defaultTarget: z.string().optional(),
  defaults: targetSchema.optional(),
  targets: z.record(
    z.string().regex(/^[A-Za-z0-9_-]+$/, 'target names may only contain letters, digits, _ and -'),
    targetSchema,
  ),
}).strict()

export type TargetConfig = z.infer<typeof targetSchema>

export interface TuskConfig {
  defaultTarget?: string
  targets: Record<string, TargetConfig>
}

export async function loadConfigFrom(path: string): Promise<TuskConfig> {
  const absolute = resolve(path)
  let raw: string
  try {
    raw = await readFile(absolute, 'utf-8')
  } catch (err) {
    throw new Error(`cannot read config ${absolute}: ${err instanceof Error ? err.message : err}`)
  }
  return parseConfig(raw, absolute)
}

export async function discoverConfig(): Promise<{ config: TuskConfig; path: string } | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(name)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    return { config: parseConfig(raw, path), path }
  }
  return undefined
}

export function parseConfig(raw: string, path: string): TuskConfig {
  let file: z.infer<typeof configFileSchema>
  try {
    file = configFileSchema.parse(interpolateEnv(parseJsonc(raw)))
  } catch (err) {
    throw new Error(`${path}: ${describeConfigError(err)}`)
  }

  const names = Object.keys(file.targets)
  if (names.length === 0) throw new Error(`${path}: no targets defined`)
  if (file.defaultTarget && !file.targets[file.defaultTarget]) {
    throw new Error(`${path}: defaultTarget "${file.defaultTarget}" is not a target (have: ${names.join(', ')})`)
  }

  const targets: Record<string, TargetConfig> = {}
  for (const [name, target] of Object.entries(file.targets)) {
    const merged = mergeTarget(file.defaults ?? {}, target)
    if (merged.ssh) {
      if (!merged.ssh.host || !merged.ssh.user) throw new Error(`${path}: target "${name}": ssh requires host and user`)
      if (!merged.ssh.key && !merged.ssh.password) throw new Error(`${path}: target "${name}": ssh requires key or password`)
    }
    targets[name] = merged
  }
  return { defaultTarget: file.defaultTarget, targets }
}

function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

export function parseJsonc(raw: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(raw)))
}

function stripComments(input: string): string {
  let out = ''
  let inString = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < input.length) { out += input[i + 1]; i += 2; continue }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') { inString = true; out += ch; i++; continue }
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    out += ch
    i++
  }
  return out
}

function stripTrailingCommas(input: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < input.length) { out += input[++i]; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === ',') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j++
      if (input[j] === '}' || input[j] === ']') continue
    }
    out += ch
  }
  return out
}

export function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const resolved = process.env[name]
      if (resolved === undefined || resolved === '') {
        throw new Error(`references ${resolved === '' ? 'empty' : 'undefined'} env var \${${name}}`)
      }
      return resolved
    })
  }
  if (Array.isArray(value)) return value.map(interpolateEnv)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item)]))
  }
  return value
}

export function mergeTarget(defaults: TargetConfig, target: TargetConfig): TargetConfig {
  const base = defined(expandConnectionString(defaults))
  const over = defined(expandConnectionString(target))
  const merged: TargetConfig = { ...base, ...over }
  if (typeof base.ssh === 'object' && typeof over.ssh === 'object') {
    merged.ssh = { ...base.ssh, ...defined(over.ssh) }
  }
  if (typeof base.ssl === 'object' && typeof over.ssl === 'object') {
    merged.ssl = { ...base.ssl, ...defined(over.ssl) }
  }
  return merged
}

function expandConnectionString(target: TargetConfig): TargetConfig {
  if (!target.connectionString) return target
  const { connectionString, ...rest } = target
  return { ...defined(parseConnectionString(connectionString)), ...defined(rest) }
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

const CONNECTION_FLAG_KEYS = [
  'host', 'port', 'user', 'password', 'password-file', 'password-cmd',
  'database', 'connection-string', 'ssl', 'ssl-ca', 'ssl-cert', 'ssl-key',
  'ssh-host', 'ssh-port', 'ssh-user', 'ssh-key', 'ssh-password',
] as const

export function usedConnectionFlags(flags: ConnectionFlags): string[] {
  return CONNECTION_FLAG_KEYS.filter(key => flags[key] !== undefined && flags[key] !== false)
}

export function configFromFlags(flags: ConnectionFlags): TuskConfig {
  let base: TargetConfig = {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  }
  if (process.env.DATABASE_URL) {
    // a fallback, not a directive: a malformed or non-postgres DATABASE_URL
    // in the ambient shell must not abort an explicitly configured server
    try {
      base = { ...base, ...defined(parseConnectionString(process.env.DATABASE_URL)) }
    } catch {}
  }
  if (flags['connection-string']) base = { ...base, ...defined(parseConnectionString(flags['connection-string'])) }

  const flagPasswordSource = Boolean(flags.password || flags['password-file'] || flags['password-cmd'])
  const target: TargetConfig = defined({
    host: flags.host ?? base.host,
    port: flags.port ?? base.port,
    user: flags.user ?? base.user,
    password: flagPasswordSource ? flags.password : base.password,
    passwordFile: flags['password-file'],
    passwordCmd: flags['password-cmd'],
    database: flags.database ?? base.database,
    ssl: sslFromFlags(flags),
    ssh: sshFromFlags(flags),
  })
  return { targets: { db: target } }
}

function sslFromFlags(flags: ConnectionFlags): TargetConfig['ssl'] {
  if (flags['ssl-ca'] || flags['ssl-cert'] || flags['ssl-key']) {
    return defined({ ca: flags['ssl-ca'], cert: flags['ssl-cert'], key: flags['ssl-key'] })
  }
  return flags.ssl ? true : undefined
}

function sshFromFlags(flags: ConnectionFlags): TargetConfig['ssh'] {
  if (!flags['ssh-host']) return undefined
  if (!flags['ssh-user']) throw new Error('--ssh-user is required when using --ssh-host')
  if (!flags['ssh-key'] && !flags['ssh-password']) {
    throw new Error('--ssh-key or --ssh-password is required when using --ssh-host')
  }
  return defined({
    host: flags['ssh-host'],
    port: flags['ssh-port'],
    user: flags['ssh-user'],
    key: flags['ssh-key'],
    password: flags['ssh-password'],
  })
}
