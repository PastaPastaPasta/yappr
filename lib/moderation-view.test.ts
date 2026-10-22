import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropsHidden, isHidden, isHiddenItem, moderationLogEnabled, moderationMarksOf, moderationViewAll, readSupersedes, shownMarks, withoutHiddenItems } from './moderation-view'

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
