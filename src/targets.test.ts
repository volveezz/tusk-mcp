import { describe, expect, test } from 'bun:test'
import { TargetRegistry } from './targets.js'

const multi = new TargetRegistry({
  defaultTarget: 'local',
  targets: {
    local: {},
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

  test('structure-only gating', () => {
    expect(multi.isStructureOnly('prod')).toBe(true)
    expect(multi.isStructureOnly('local')).toBe(false)
    expect(multi.anyQueryable).toBe(true)
    expect(multi.queryableNames()).toEqual(['local'])
    expect(new TargetRegistry({ targets: { a: { structureOnly: true } } }).anyQueryable).toBe(false)
  })
})
