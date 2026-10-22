import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropsHidden, isHidden, moderationLogEnabled, moderationMarksOf, moderationViewAll } from './moderation-view'

afterEach(() => vi.unstubAllEnvs())

describe('the build flags', () => {
  it('are off unless set exactly', () => {
    expect(moderationViewAll()).toBe(false)
    expect(moderationLogEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'true')
    vi.stubEnv('NEXT_PUBLIC_MODERATION_LOG', 'true')
    expect(moderationViewAll()).toBe(false)
    expect(moderationLogEnabled()).toBe(false)
  })

  it('turn on with `all` and `1`', () => {
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    vi.stubEnv('NEXT_PUBLIC_MODERATION_LOG', '1')
    expect(moderationViewAll()).toBe(true)
    expect(moderationLogEnabled()).toBe(true)
  })
})

describe('isHidden and dropsHidden', () => {
  it('treats a document with a moderator `mod` as hidden', () => {
    expect(isHidden({ mod: 1 })).toBe(true)
    expect(isHidden({ mod: 2 })).toBe(true)
    expect(isHidden({})).toBe(false)
    expect(isHidden({ mod: 0 })).toBe(false)
    expect(isHidden({ mod: null })).toBe(false)
    expect(isHidden({ mod: '1' })).toBe(false)
    expect(isHidden(null)).toBe(false)
    expect(isHidden(undefined)).toBe(false)
  })

  it('drops a hidden document on a default build and keeps it on an archival one', () => {
    expect(dropsHidden({ mod: 1 })).toBe(true)
    expect(dropsHidden({})).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    expect(dropsHidden({ mod: 1 })).toBe(false)
    expect(isHidden({ mod: 1 })).toBe(true)
  })
})

describe('moderationMarksOf', () => {
  it('reads the moderator-only fields of a plain document', () => {
    expect(moderationMarksOf({ mod: 1, modLabel: 7, $moderatedBy: 'ModeratorId', $moderatedAt: 1_700_000_000_000 })).toEqual({
      mod: 1, modLabel: 7, moderatedBy: 'ModeratorId', moderatedAt: 1_700_000_000_000,
    })
  })

  it('returns nothing for a listed document', () => {
    expect(moderationMarksOf({ content: 'hello', $createdAt: 5 })).toEqual({})
    expect(moderationMarksOf({ mod: 0, modLabel: 0, $moderatedBy: '', $moderatedAt: 0 })).toEqual({})
  })

  it('accepts a timestamp as a bigint or a numeric string', () => {
    expect(moderationMarksOf({ mod: 2, $moderatedAt: 1234n }).moderatedAt).toBe(1234)
    expect(moderationMarksOf({ mod: 2, $moderatedAt: '1234' }).moderatedAt).toBe(1234)
    expect(moderationMarksOf({ mod: 2, $moderatedAt: 'soon' }).moderatedAt).toBeUndefined()
  })

  it('ignores a moderator that is not an identifier string', () => {
    expect(moderationMarksOf({ mod: 1, $moderatedBy: new Uint8Array(32) }).moderatedBy).toBeUndefined()
  })
})
