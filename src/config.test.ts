import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'fs/promises'
import { configFromFlags, interpolateEnv, mergeTarget, parseConfig, parseJsonc, resolveAccess, resolveConfig, usedConnectionFlags } from './config.js'

describe('parseJsonc', () => {
  test('strips line comments, block comments, and trailing commas', () => {
    const raw = `{
      // dev target
      "targets": {
        "local": { "host": "localhost", /* inline */ "port": 5432, },
      },
    }`
    expect(parseJsonc(raw)).toEqual({ targets: { local: { host: 'localhost', port: 5432 } } })
  })

  test('leaves comment-like and comma sequences inside strings intact', () => {
    expect(parseJsonc('{"url": "http://x/*y", "note": "a, }", "q": "-- not a comment"}')).toEqual({
      url: 'http://x/*y',
      note: 'a, }',
      q: '-- not a comment',
    })
  })

  test('a block comment separates tokens instead of gluing them', () => {
    expect(() => parseJsonc('{"port": 54/*c*/32}')).toThrow()
  })
})

describe('interpolateEnv', () => {
  afterEach(() => {
    delete process.env.TUSK_TEST_SECRET
  })

  test('replaces ${VAR} in nested values', () => {
    process.env.TUSK_TEST_SECRET = 'hunter2'
    expect(interpolateEnv({ targets: { prod: { password: '${TUSK_TEST_SECRET}' } } })).toEqual({
      targets: { prod: { password: 'hunter2' } },
    })
  })

  test('throws on undefined and empty env vars', () => {
    expect(() => interpolateEnv({ password: '${TUSK_TEST_MISSING_VAR}' })).toThrow('TUSK_TEST_MISSING_VAR')
    process.env.TUSK_TEST_SECRET = ''
    expect(() => interpolateEnv('${TUSK_TEST_SECRET}')).toThrow('empty')
  })
})

describe('mergeTarget', () => {
  test('target fields override defaults, unset fields fall through', () => {
    const merged = mergeTarget(
      { user: 'app', database: 'myapp', port: 5432 },
      { host: 'stage.db', port: 6432 },
    )
    expect(merged).toEqual({ user: 'app', database: 'myapp', host: 'stage.db', port: 6432 })
  })

  test('connectionString expands but explicit fields beat it', () => {
    const merged = mergeTarget(
      { user: 'app' },
      { connectionString: 'postgres://cs_user:pw@db.example.com:6543/csdb', database: 'override' },
    )
    expect(merged).toEqual({
      host: 'db.example.com',
      port: 6543,
      user: 'cs_user',
      password: 'pw',
      database: 'override',
    })
  })

  test('fields absent from a connectionString do not clobber defaults', () => {
    const merged = mergeTarget({ port: 6432, user: 'app' }, { connectionString: 'postgres://u@h/db' })
    expect(merged).toEqual({ port: 6432, user: 'u', host: 'h', database: 'db' })
  })

  test('access and its structureOnly alias override each other across levels', () => {
    expect(mergeTarget({ access: 'write' }, { structureOnly: true })).toEqual({ access: 'structure' })
    expect(mergeTarget({ structureOnly: true }, { access: 'write' })).toEqual({ access: 'write' })
    expect(mergeTarget({ access: 'write' }, { host: 'h' })).toEqual({ access: 'write', host: 'h' })
    // "not structure-only" is not a claim about read vs write
    expect(mergeTarget({ access: 'write' }, { structureOnly: false })).toEqual({ access: 'write' })
    expect(mergeTarget({}, {})).toEqual({})
  })

  test('ssh blocks deep-merge so a target can override one field', () => {
    const merged = mergeTarget(
      { ssh: { host: 'bastion', user: 'deploy', key: '~/.ssh/id_rsa' } },
      { ssh: { port: 2222 } },
    )
    expect(merged.ssh).toEqual({ host: 'bastion', user: 'deploy', key: '~/.ssh/id_rsa', port: 2222 })
  })

  test('a target naming one hop drops the other, and any address, inherited from defaults', () => {
    const ssh = { host: 'bastion', user: 'deploy', key: '~/.ssh/id_rsa' }
    expect(mergeTarget({ ssh, host: 'db.internal', port: 6432, user: 'app' }, { proxyCommand: 'ssh node nc db 5432' }))
      .toEqual({ proxyCommand: 'ssh node nc db 5432', user: 'app' })
    expect(mergeTarget({ proxyCommand: 'ssh node nc db 5432' }, { ssh })).toEqual({ ssh })
    expect(mergeTarget({ ssh }, { host: 'h' })).toEqual({ ssh, host: 'h' })
  })
})

describe('parseConfig', () => {
  test('rejects unknown keys, bad defaultTarget, and incomplete merged ssh', () => {
    expect(() => parseConfig('{"targets": {"a": {"hots": "x"}}}', 'f')).toThrow('hots')
    expect(() => parseConfig('{"defaultTarget": "b", "targets": {"a": {}}}', 'f')).toThrow('defaultTarget "b"')
    expect(() => parseConfig('{"targets": {"a": {"ssh": {"host": "bastion"}}}}', 'f')).toThrow('ssh requires host and user')
    expect(() => parseConfig('{"targets": {"a": {"ssh": {"host": "b", "user": "u"}}}}', 'f')).toThrow('key or password')
    expect(() => parseConfig('{"targets": {"a": {"access": "readonly"}}}', 'f')).toThrow('access')
    expect(() => parseConfig('{"targets": {"a": {"proxyCommand": "nc db 5432", "ssh": {"host": "b", "user": "u", "key": "k"}}}}', 'f'))
      .toThrow('keep one')
    expect(() => parseConfig('{"targets": {"a": {"proxyCommand": "nc db 5432", "host": "db", "port": 5432}}}', 'f'))
      .toThrow('host and port cannot be combined with proxyCommand')
    expect(() => parseConfig('{"targets": {"a": {"access": "write", "structureOnly": true}}}', 'f')).toThrow('structureOnly conflicts')
  })

  test('access resolves from either spelling, defaulting to read', () => {
    const config = parseConfig('{"targets": {"a": {}, "b": {"structureOnly": true}, "c": {"access": "write"}}}', 'f')
    expect(resolveAccess(config.targets.a)).toBe('read')
    expect(resolveAccess(config.targets.b)).toBe('structure')
    expect(resolveAccess(config.targets.c)).toBe('write')
  })

  test('merges defaults into every target', () => {
    const config = parseConfig('{"defaults": {"user": "app"}, "targets": {"a": {"host": "h1"}, "b": {"host": "h2", "user": "other"}}}', 'f')
    expect(config.targets.a).toEqual({ user: 'app', host: 'h1' })
    expect(config.targets.b).toEqual({ user: 'other', host: 'h2' })
  })
})

describe('resolveConfig', () => {
  const configPath = new URL('../tusk.config.test.jsonc', import.meta.url).pathname

  beforeAll(async () => {
    await writeFile(configPath, '{"targets": {"a": {"host": "h"}, "b": {"access": "structure"}}}')
  })
  afterAll(async () => {
    await rm(configPath)
  })

  test('access flags blanket every target, and cannot contradict each other', async () => {
    const writes = await resolveConfig({ host: 'h', 'allow-writes': true })
    expect(resolveAccess(writes.targets.db)).toBe('write')

    const structure = await resolveConfig({ host: 'h', 'structure-only': true })
    expect(resolveAccess(structure.targets.db)).toBe('structure')

    await expect(resolveConfig({ host: 'h', 'structure-only': true, 'allow-writes': true }))
      .rejects.toThrow('mutually exclusive')
  })

  test('--structure-only narrows a config file but --allow-writes cannot escalate one', async () => {
    const narrowed = await resolveConfig({ config: configPath, 'structure-only': true })
    expect(Object.values(narrowed.targets).map(resolveAccess)).toEqual(['structure', 'structure'])

    await expect(resolveConfig({ config: configPath, 'allow-writes': true }))
      .rejects.toThrow('cannot be combined with a config file')
  })
})

describe('usedConnectionFlags', () => {
  test('access and config are mode flags, not connection flags', () => {
    expect(usedConnectionFlags({ 'structure-only': true, 'allow-writes': true, config: 'x' })).toEqual([])
    expect(usedConnectionFlags({ host: 'h', ssl: false })).toEqual(['host'])
  })
})

describe('configFromFlags', () => {
  afterEach(() => {
    delete process.env.PGHOST
    delete process.env.PGPASSWORD
  })

  test('flags beat env vars and produce a single unnamed target', () => {
    process.env.PGHOST = 'env-host'
    process.env.PGPASSWORD = 'env-pw'
    const config = configFromFlags({ host: 'flag-host', database: 'mydb' })
    expect(config.defaultTarget).toBeUndefined()
    expect(config.targets).toEqual({ db: { host: 'flag-host', database: 'mydb', password: 'env-pw' } })
  })

  test('password-file suppresses env password fallback', () => {
    process.env.PGPASSWORD = 'env-pw'
    const config = configFromFlags({ 'password-file': '/run/secrets/pw' })
    expect(config.targets.db.password).toBeUndefined()
    expect(config.targets.db.passwordFile).toBe('/run/secrets/pw')
  })

  test('proxy-command owns the hop, over env addresses, ssh flags, and host flags', () => {
    process.env.PGHOST = 'env-host'
    expect(configFromFlags({ 'proxy-command': 'ssh node nc db 5432', database: 'mydb' }).targets.db)
      .toEqual({ proxyCommand: 'ssh node nc db 5432', database: 'mydb' })
    expect(() => configFromFlags({ 'proxy-command': 'x', 'ssh-host': 'bastion', 'ssh-user': 'u', 'ssh-key': 'k' }))
      .toThrow('keep one')
    expect(() => configFromFlags({ 'proxy-command': 'x', host: 'db' }))
      .toThrow('--host cannot be combined with --proxy-command')
  })
})
