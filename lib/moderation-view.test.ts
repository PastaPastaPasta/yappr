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
  moderatorViewHolds,
  moderatorViewScope,
  readSupersedes,
  setModeratorViewContracts,
  shownMarks,
  viewerChangeReloads,
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

describe('shownMarks', () => {
  const hidden = { mod: 1, modLabel: 3, moderatedAt: 2_000 }
  const proved = { marks: hidden, at: 2_000, proved: true }

  it('shows the read when nothing was recorded', () => {
    expect(shownMarks({ mod: 2 }, undefined, false)).toEqual({ mod: 2 })
  })

  it('shows a proved change over a read from before it', () => {
    expect(shownMarks(undefined, proved, true)).toEqual(hidden)
    expect(shownMarks({ moderatedAt: 1_000 }, proved, true)).toEqual(hidden)
    expect(shownMarks({ moderatedAt: 2_000 }, proved, true)).toEqual(hidden)
    expect(shownMarks({ mod: 1, moderatedAt: 1_000 }, { marks: null, at: 2_000, proved: true }, true)).toBeUndefined()
  })

  it('gives way to a read that carries a later moderator change', () => {
    expect(shownMarks({ mod: 2, moderatedAt: 3_000 }, proved, false)).toEqual({ mod: 2, moderatedAt: 3_000 })
  })

  it('shows an unproved change only until a new read arrives', () => {
    const unproved = { marks: null, at: 2_000, proved: false }
    const stale = { mod: 1, moderatedAt: 1_000 }
    expect(shownMarks(stale, unproved, false)).toBeUndefined()
    // The unhide never landed: the next read, still hidden, is the truth.
    expect(shownMarks(stale, unproved, true)).toEqual(stale)
  })

  it('tells when a read supersedes a record, so the record can be dropped', () => {
    expect(readSupersedes({ moderatedAt: 3_000 }, proved, false)).toBe(true)
    expect(readSupersedes({ moderatedAt: 1_000 }, proved, true)).toBe(false)
    // A read with no marks proves nothing about a proved record.
    expect(readSupersedes(undefined, { marks: null, at: 2_000, proved: true }, true)).toBe(false)
    expect(readSupersedes(undefined, { marks: null, at: 2_000, proved: false }, true)).toBe(true)
  })

  it('keeps the read\'s restriction flag, which no hide or unhide changes', () => {
    expect(shownMarks({ restricted: true }, proved, false)).toEqual({ ...hidden, restricted: true })
    expect(shownMarks({ mod: 1, restricted: true }, { marks: null, at: 2_000, proved: true }, false)).toEqual({ restricted: true })
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

})

describe('moderatorViewHolds: nothing mounts or reads before the view is applied', () => {
  const state = (overrides: Partial<Parameters<typeof moderatorViewHolds>[0]> = {}) =>
    ({ booted: true, viewer: 'alice', enabledFor: 'alice', seatedFor: null, ...overrides })

  it('never holds a tab where the view is off', () => {
    expect(moderatorViewHolds(state({ enabledFor: null, booted: false }))).toBe(false)
    expect(moderatorViewHolds(state({ enabledFor: null }))).toBe(false)
  })

  it('holds a tab where it is on until the session is restored and the seats are read', () => {
    expect(moderatorViewHolds(state({ booted: false, viewer: null }))).toBe(true)
    expect(moderatorViewHolds(state())).toBe(true)
    expect(moderatorViewHolds(state({ seatedFor: 'alice' }))).toBe(false)
  })

  it('releases at once for anyone but the identity that turned it on', () => {
    expect(moderatorViewHolds(state({ viewer: null }))).toBe(false)
    expect(moderatorViewHolds(state({ viewer: 'mallory' }))).toBe(false)
  })
})

describe('viewerChangeReloads: a change of view after load is always a reload', () => {
  it('reloads when a moderator session with the view on signs out or switches', () => {
    expect(viewerChangeReloads({ activeContracts: 1, enabledFor: 'alice', nextViewer: null })).toBe(true)
    expect(viewerChangeReloads({ activeContracts: 2, enabledFor: 'alice', nextViewer: 'bob' })).toBe(true)
  })

  it('reloads when the identity that turned it on in this tab signs back in', () => {
    expect(viewerChangeReloads({ activeContracts: 0, enabledFor: 'alice', nextViewer: 'alice' })).toBe(true)
  })

  it('leaves everyone else alone', () => {
    expect(viewerChangeReloads({ activeContracts: 0, enabledFor: null, nextViewer: 'alice' })).toBe(false)
    expect(viewerChangeReloads({ activeContracts: 0, enabledFor: 'alice', nextViewer: 'bob' })).toBe(false)
    expect(viewerChangeReloads({ activeContracts: 0, enabledFor: null, nextViewer: null })).toBe(false)
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
