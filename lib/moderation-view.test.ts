import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  actionsBlockedByHide,
  archivalBuild,
  dropsHidden,
  isHidden,
  isHiddenItem,
  moderationLogEnabled,
  moderationMarksOf,
  moderationViewAll,
  moderatorViewScope,
  onModeratorViewChange,
  setModeratorViewContracts,
  withoutHiddenItems,
} from './moderation-view'

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

describe('isHiddenItem and withoutHiddenItems', () => {
  it('drop hidden documents from a public list, and keep them on an archival build', () => {
    const listed = { id: 'a' }
    const hidden = { id: 'b', moderation: { mod: 1 } }
    const held = { id: 'c', moderation: { mod: 2 } }
    expect(withoutHiddenItems([listed, hidden, held])).toEqual([listed])
    expect(isHiddenItem(hidden)).toBe(true)
    expect(isHiddenItem(listed)).toBe(false)
    expect(isHiddenItem(null)).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    expect(withoutHiddenItems([listed, hidden, held])).toEqual([listed, hidden, held])
    expect(isHiddenItem(hidden)).toBe(false)
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

describe('the moderator view', () => {
  afterEach(() => {
    setModeratorViewContracts([])
  })

  it('is off until set, and then only for the contracts it was set for', () => {
    expect(moderationViewAll()).toBe(false)
    expect(moderationViewAll('blog')).toBe(false)
    setModeratorViewContracts(['social'])
    expect(moderationViewAll()).toBe(true)
    expect(moderationViewAll('social')).toBe(true)
    expect(moderationViewAll('blog')).toBe(false)
    expect(moderationViewAll('storefront')).toBe(false)
    setModeratorViewContracts([])
    expect(moderationViewAll()).toBe(false)
  })

  it('keeps a hidden item of its contract and drops one of another', () => {
    const hidden = { id: 'b', moderation: { mod: 1 } }
    setModeratorViewContracts(['social'])
    expect(withoutHiddenItems([hidden])).toEqual([hidden])
    expect(withoutHiddenItems([hidden], 'blog')).toEqual([])
    expect(dropsHidden({ mod: 1 }, 'storefront')).toBe(true)
  })

  it('unlocks no action on hidden content: only an archival build does', () => {
    const hidden = { moderation: { mod: 1 } }
    setModeratorViewContracts(['social', 'blog', 'storefront'])
    expect(actionsBlockedByHide(hidden)).toBe(true)
    expect(actionsBlockedByHide({ moderation: {} })).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    expect(actionsBlockedByHide(hidden)).toBe(false)
  })

  it('does not turn the build flags on', () => {
    setModeratorViewContracts(['social', 'blog', 'storefront'])
    expect(archivalBuild()).toBe(false)
    expect(moderationLogEnabled()).toBe(false)
  })

  it('tells its listeners when, and only when, it changes', () => {
    const listener = vi.fn()
    onModeratorViewChange(listener)
    expect(setModeratorViewContracts(['social'])).toBe(true)
    expect(setModeratorViewContracts(['social'])).toBe(false)
    expect(setModeratorViewContracts(['social', 'blog'])).toBe(true)
    expect(setModeratorViewContracts([])).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('moderatorViewScope', () => {
  const state = (overrides: Partial<Parameters<typeof moderatorViewScope>[0]> = {}) =>
    ({ viewer: 'alice', seatedFor: 'alice', seated: ['social', 'blog'] as const, enabled: true, ...overrides })

  it('covers the viewer\'s verified seats once they turned it on', () => {
    expect(moderatorViewScope(state())).toEqual(['social', 'blog'])
  })

  it('is empty for anyone who is not a verified seated moderator', () => {
    // Signed out.
    expect(moderatorViewScope(state({ viewer: null }))).toEqual([])
    // Seats not read yet, or read for someone else (a switch of account).
    expect(moderatorViewScope(state({ seatedFor: null }))).toEqual([])
    expect(moderatorViewScope(state({ viewer: 'mallory' }))).toEqual([])
    // On no seated team: the switch alone turns nothing on.
    expect(moderatorViewScope(state({ seated: [] }))).toEqual([])
  })

  it('is empty while the switch is off', () => {
    expect(moderatorViewScope(state({ enabled: false }))).toEqual([])
  })
})
