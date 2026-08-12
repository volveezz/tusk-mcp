import { describe, expect, test } from 'bun:test'
import { TargetRegistry } from './targets.js'

const multi = new TargetRegistry({
  defaultTarget: 'local',
  targets: {
    local: { access: 'write' },
    stage: {},
    prod: { structureOnly: true, description: 'production' },
  },
})

const single = new TargetRegistry({ targets: { db: {} } })

const noDefault = new TargetRegistry({ targets: { a: {}, b: {} } })

describe('TargetRegistry', () => {
  test('resolveName: explicit, default, single-target, and missing cases', () => {
    expect(multi.resolveName('prod')).toBe('prod')
    expect(multi.resolveName()).toBe('local')
    expect(single.resolveName()).toBe('db')
    expect(() => noDefault.resolveName()).toThrow('target is required')
    expect(() => multi.resolveName('ghost')).toThrow('unknown target')
  })

  test('targetShape: absent for single target, optional with default, required without', () => {
    expect(single.targetShape()).toEqual({})
    expect(multi.targetShape().target.safeParse(undefined).success).toBe(true)
    expect(noDefault.targetShape().target.safeParse(undefined).success).toBe(false)
    expect(noDefault.targetShape().target.safeParse('a').success).toBe(true)
    expect(noDefault.targetShape().target.safeParse('ghost').success).toBe(false)
  })

  test('access gating across the three levels', () => {
    expect(multi.access('prod')).toBe('structure')
    expect(multi.access('stage')).toBe('read')
    expect(multi.access('local')).toBe('write')
    expect(multi.anyQueryable).toBe(true)
    expect(multi.queryableNames()).toEqual(['local', 'stage'])
    expect(multi.anyWritable).toBe(true)
    expect(multi.writableNames()).toEqual(['local'])
    expect(new TargetRegistry({ targets: { a: { structureOnly: true } } }).anyQueryable).toBe(false)
    expect(new TargetRegistry({ targets: { a: {} } }).anyWritable).toBe(false)
  })

  test('writeTargetShape only accepts write-enabled targets', () => {
    const target = multi.writeTargetShape().target
    expect(target.safeParse('local').success).toBe(true)
    expect(target.safeParse('stage').success).toBe(false)
    expect(target.safeParse(undefined).success).toBe(true)
    expect(new TargetRegistry({ targets: { db: { access: 'write' } } }).writeTargetShape()).toEqual({})
  })

  test('writeTargetShape requires an explicit target when the default cannot write', () => {
    const registry = new TargetRegistry({
      defaultTarget: 'stage',
      targets: { stage: {}, local: { access: 'write' } },
    })
    expect(registry.writeTargetShape().target.safeParse(undefined).success).toBe(false)
    expect(registry.writeTargetShape().target.safeParse('local').success).toBe(true)
  })
})
