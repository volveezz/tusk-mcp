/**
 * Lazy connection registry: one entry per named target from TuskConfig.
 * Pool, password source, SSL material, and SSH tunnel are resolved on the
 * first tool call touching a target, so an unreachable target never blocks
 * startup or the other targets. Failures before the pool exists (password
 * source, SSL files, tunnel) evict the entry and retry on next use; the
 * pool itself connects lazily inside postgres.js.
 * Also owns the `target` input field tools spread into their schemas
 * (absent entirely for single-target configs).
 */
import { execSync } from 'child_process'
import { readFile } from 'fs/promises'
import { z } from 'zod'
import { createPostgresClient } from './client.js'
import { createProxyCommandTunnel, createTunnel } from './tunnel.js'
import { resolveAccess } from './config.js'
import type { AccessLevel, TargetConfig, TuskConfig } from './config.js'
import type { PostgresClient, PostgresConnectionOptions, Tunnel } from './types.js'

interface ActiveTarget {
  client: PostgresClient
  tunnel?: Tunnel
}

export class TargetRegistry {
  private active = new Map<string, Promise<ActiveTarget>>()

  constructor(private config: TuskConfig) {}

  names(): string[] {
    return Object.keys(this.config.targets)
  }

  get multiTarget(): boolean {
    return this.names().length > 1
  }

  get defaultTarget(): string | undefined {
    return this.config.defaultTarget
  }

  get anyQueryable(): boolean {
    return this.queryableNames().length > 0
  }

  get anyWritable(): boolean {
    return this.writableNames().length > 0
  }

  queryableNames(): string[] {
    return this.names().filter(name => !this.isStructureOnly(name))
  }

  writableNames(): string[] {
    return this.names().filter(name => this.canWrite(name))
  }

  access(name: string): AccessLevel {
    return resolveAccess(this.targetConfig(name))
  }

  isStructureOnly(name: string): boolean {
    return this.access(name) === 'structure'
  }

  canWrite(name: string): boolean {
    return this.access(name) === 'write'
  }

  description(name: string): string | undefined {
    return this.targetConfig(name).description
  }

  targetShape(): Record<string, z.ZodTypeAny> {
    return this.shapeFor(this.names())
  }

  /**
   * Like targetShape() but narrowed to write-enabled targets, so a read-only
   * target is not even expressible as an argument to execute-write.
   */
  writeTargetShape(): Record<string, z.ZodTypeAny> {
    return this.shapeFor(this.writableNames())
  }

  targetEnum(): z.ZodEnum<[string, ...string[]]> {
    const names = this.names()
    return z.enum([names[0], ...names.slice(1)])
  }

  /** Omits the param entirely for a single target, and makes it optional only when the default is in `allowed`. */
  private shapeFor(allowed: string[]): Record<string, z.ZodTypeAny> {
    if (!this.multiTarget || allowed.length === 0) return {}
    const enumSchema = z.enum([allowed[0], ...allowed.slice(1)])
    const fallback = this.defaultTarget && allowed.includes(this.defaultTarget) ? this.defaultTarget : undefined
    return { target: fallback ? enumSchema.optional().describe(`Defaults to ${fallback}`) : enumSchema }
  }

  resolveName(requested?: string): string {
    if (requested) {
      this.targetConfig(requested)
      return requested
    }
    if (this.config.defaultTarget) return this.config.defaultTarget
    const names = this.names()
    if (names.length === 1) return names[0]
    throw new Error(`target is required (one of: ${names.join(', ')})`)
  }

  async client(name: string): Promise<PostgresClient> {
    let pending = this.active.get(name)
    if (!pending) {
      pending = this.connect(name)
      this.active.set(name, pending)
      pending.catch(() => this.active.delete(name))
      pending.then(({ tunnel }) => tunnel?.broken?.then(err => this.discard(name, pending!, err)), () => {})
    }
    return (await pending).client
  }

  /** A hop that died mid-session takes its target's entry with it, so the next tool call reconnects and reports the live reason. */
  private discard(name: string, entry: Promise<ActiveTarget>, err: Error): void {
    if (this.active.get(name) !== entry) return
    this.active.delete(name)
    console.error(`tusk-mcp: target "${name}" disconnected: ${err.message}`)
    entry.then(async ({ client, tunnel }) => {
      await client.close(0).catch(() => {})
      await tunnel?.close()
    }).catch(() => {})
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.active.values()].map(async pending => {
      try {
        const { client, tunnel } = await pending
        await client.close()
        await tunnel?.close()
      } catch {}
    }))
    this.active.clear()
  }

  private targetConfig(name: string): TargetConfig {
    const target = this.config.targets[name]
    if (!target) throw new Error(`unknown target "${name}" (configured: ${this.names().join(', ')})`)
    return target
  }

  private async connect(name: string): Promise<ActiveTarget> {
    try {
      return await this.connectUnwrapped(name)
    } catch (err) {
      throw new Error(`target "${name}": ${err instanceof Error ? err.message : err}`)
    }
  }

  private async connectUnwrapped(name: string): Promise<ActiveTarget> {
    const target = this.targetConfig(name)
    const options: PostgresConnectionOptions = {
      host: target.host ?? 'localhost',
      port: target.port ?? 5432,
      user: target.user,
      password: await resolvePassword(target),
      database: target.database,
      ssl: await resolveSsl(target.ssl),
      readOnly: resolveAccess(target) !== 'write',
    }

    let tunnel: Tunnel | undefined
    if (target.proxyCommand) {
      tunnel = await createProxyCommandTunnel(target.proxyCommand)
    } else if (target.ssh) {
      const { host: sshHost, user: sshUser } = target.ssh
      if (!sshHost || !sshUser) throw new Error('ssh config requires host and user')
      tunnel = await createTunnel({
        sshHost,
        sshPort: target.ssh.port ?? 22,
        sshUser,
        sshKey: target.ssh.key,
        sshPassword: target.ssh.password,
        targetHost: options.host,
        targetPort: options.port,
      })
    }
    if (tunnel) {
      options.host = tunnel.localHost
      options.port = tunnel.localPort
    }

    return { client: createPostgresClient(options), tunnel }
  }
}

async function resolvePassword(target: TargetConfig): Promise<string | undefined> {
  if (target.password !== undefined) return target.password
  if (target.passwordFile) return (await readFile(target.passwordFile, 'utf-8')).trim()
  if (target.passwordCmd) {
    try {
      return execSync(target.passwordCmd, { encoding: 'utf-8' }).trim()
    } catch {
      throw new Error(`passwordCmd failed: ${target.passwordCmd}`)
    }
  }
  return undefined
}

async function resolveSsl(ssl: TargetConfig['ssl']): Promise<PostgresConnectionOptions['ssl']> {
  if (!ssl) return false
  if (ssl === true) return { rejectUnauthorized: false }
  const resolved: Exclude<PostgresConnectionOptions['ssl'], boolean | undefined> = { rejectUnauthorized: true }
  if (ssl.ca) resolved.ca = await readFile(ssl.ca, 'utf-8')
  if (ssl.cert) resolved.cert = await readFile(ssl.cert, 'utf-8')
  if (ssl.key) resolved.key = await readFile(ssl.key, 'utf-8')
  return resolved
}
