import { afterEach, describe, expect, test } from 'bun:test'
import { configFromFlags, interpolateEnv, mergeTarget, parseConfig, parseJsonc, usedConnectionFlags } from './config.js'

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

  test('ssh blocks deep-merge so a target can override one field', () => {
    const merged = mergeTarget(
      { ssh: { host: 'bastion', user: 'deploy', key: '~/.ssh/id_rsa' } },
      { ssh: { port: 2222 } },
    )
    expect(merged.ssh).toEqual({ host: 'bastion', user: 'deploy', key: '~/.ssh/id_rsa', port: 2222 })
  })
})

describe('parseConfig', () => {
  test('rejects unknown keys, bad defaultTarget, and incomplete merged ssh', () => {
    expect(() => parseConfig('{"targets": {"a": {"hots": "x"}}}', 'f')).toThrow('hots')
    expect(() => parseConfig('{"defaultTarget": "b", "targets": {"a": {}}}', 'f')).toThrow('defaultTarget "b"')
    expect(() => parseConfig('{"targets": {"a": {"ssh": {"host": "bastion"}}}}', 'f')).toThrow('ssh requires host and user')
    expect(() => parseConfig('{"targets": {"a": {"ssh": {"host": "b", "user": "u"}}}}', 'f')).toThrow('key or password')
  })

  test('merges defaults into every target', () => {
    const config = parseConfig('{"defaults": {"user": "app"}, "targets": {"a": {"host": "h1"}, "b": {"host": "h2", "user": "other"}}}', 'f')
    expect(config.targets.a).toEqual({ user: 'app', host: 'h1' })
    expect(config.targets.b).toEqual({ user: 'other', host: 'h2' })
  })
})

describe('usedConnectionFlags', () => {
  test('structure-only and config are mode flags, not connection flags', () => {
    expect(usedConnectionFlags({ 'structure-only': true, config: 'x' })).toEqual([])
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
})
