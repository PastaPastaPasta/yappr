import { describe, expect, it } from 'vitest'
import {
  OPENING_CACHE_MAX_AGE_MS,
  announcesOpening,
  parseCachedOpening,
  postingOpening,
  postingOpensText,
  serializeOpening,
  type PostingOpeningInput,
} from './posting-opens'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function status(overrides: Partial<PostingOpeningInput> = {}): PostingOpeningInput {
  return { declaration: { interim: 'notYetUsable' }, seated: null, contest: null, failures: [], ...overrides }
}

describe('postingOpening', () => {
  it('announces nothing while the status is unread', () => {
    expect(postingOpening(null, NOW)).toEqual({ kind: 'unknown' })
  })

  it('is open off a notYetUsable interim', () => {
    for (const interim of ['contractOwner', 'appointedModerators', 'noModeration']) {
      expect(postingOpening(status({ declaration: { interim } }), NOW)).toEqual({ kind: 'open' })
    }
  })

  it('is open once a team is seated, whatever the contest says', () => {
    const seated = { leaderId: 'L' }
    expect(postingOpening(status({ seated }), NOW)).toEqual({ kind: 'open' })
    expect(postingOpening(status({ seated, contest: { winner: { kind: 'WonByIdentity' }, endsAtMs: NOW - HOUR } }), NOW)).toEqual({ kind: 'open' })
  })

  it('never calls posting closed when the seat could not be read', () => {
    expect(postingOpening(status({ failures: ['seatedTeam'] }), NOW)).toEqual({ kind: 'unknown' })
    expect(postingOpening(status({ failures: ['seatedTeam', 'contest'], contest: { winner: null, endsAtMs: NOW + HOUR } }), NOW)).toEqual({ kind: 'unknown' })
  })

  it('gives the contest end as the earliest moment a team can be seated', () => {
    expect(postingOpening(status({ contest: { winner: null, endsAtMs: NOW + 5 * HOUR } }), NOW)).toEqual({ kind: 'at', atMs: NOW + 5 * HOUR })
  })

  it('says "shortly" once the contest is decided or its end has passed without a team', () => {
    expect(postingOpening(status({ contest: { winner: { kind: 'WonByIdentity' }, endsAtMs: NOW + HOUR } }), NOW)).toEqual({ kind: 'soon' })
    expect(postingOpening(status({ contest: { winner: null, endsAtMs: NOW - HOUR } }), NOW)).toEqual({ kind: 'soon' })
    expect(postingOpening(status({ contest: { winner: null, endsAtMs: NOW } }), NOW)).toEqual({ kind: 'soon' })
  })

  it('has no date before a charter enters the contest, or when its end could not be read', () => {
    expect(postingOpening(status(), NOW)).toEqual({ kind: 'pending' })
    // A failed contest read still leaves the contract closed: only the date is unknown.
    expect(postingOpening(status({ failures: ['contest'] }), NOW)).toEqual({ kind: 'pending' })
    expect(postingOpening(status({ contest: { winner: null, endsAtMs: null } }), NOW)).toEqual({ kind: 'pending' })
    expect(postingOpening(status({ contest: { winner: null, endsAtMs: Number.NaN } }), NOW)).toEqual({ kind: 'pending' })
    expect(postingOpening(status({ failures: ['contestEnd'], contest: { winner: null, endsAtMs: null } }), NOW)).toEqual({ kind: 'pending' })
  })
})

describe('postingOpensText', () => {
  const format = (ms: number) => `T${ms - NOW}`

  it('words each state, and says nothing for open or unknown', () => {
    expect(postingOpensText({ kind: 'at', atMs: NOW + HOUR }, format, NOW)).toBe(`Posting opens on T${HOUR}`)
    expect(postingOpensText({ kind: 'soon' }, format)).toBe('Posting opens shortly')
    expect(postingOpensText({ kind: 'pending' }, format)).toBe('Posting opens once the first moderators are elected')
    expect(postingOpensText({ kind: 'open' }, format)).toBeNull()
    expect(postingOpensText({ kind: 'unknown' }, format)).toBeNull()
  })

  it('formats a date by default', () => {
    expect(postingOpensText({ kind: 'at', atMs: NOW }, undefined, NOW - 1) ?? '').toMatch(/^Posting opens on .*2027/)
  })

  it('says "shortly", never a past date, once the remembered time has passed', () => {
    expect(postingOpensText({ kind: 'at', atMs: NOW }, format, NOW)).toBe('Posting opens shortly')
    expect(postingOpensText({ kind: 'at', atMs: NOW }, format, NOW + HOUR)).toBe('Posting opens shortly')
  })

  it('never uses removal words', () => {
    for (const opening of [{ kind: 'at', atMs: NOW }, { kind: 'soon' }, { kind: 'pending' }] as const) {
      expect(postingOpensText(opening, undefined, NOW - 1)).not.toMatch(/remov|delet/i)
    }
  })

  it('announces exactly the states that have text', () => {
    for (const opening of [{ kind: 'open' }, { kind: 'unknown' }, { kind: 'soon' }, { kind: 'pending' }, { kind: 'at', atMs: NOW }] as const) {
      expect(announcesOpening(opening)).toBe(postingOpensText(opening, undefined, NOW - 1) !== null)
    }
  })
})

describe('remembered opening', () => {
  it('round-trips the states a banner can paint', () => {
    for (const opening of [{ kind: 'at', atMs: NOW + 2 * HOUR }, { kind: 'soon' }, { kind: 'pending' }] as const) {
      expect(parseCachedOpening(serializeOpening(opening, NOW), NOW + HOUR)).toEqual(opening)
    }
  })

  it('turns a remembered date that has passed into "soon"', () => {
    const raw = serializeOpening({ kind: 'at', atMs: NOW + HOUR }, NOW)
    expect(parseCachedOpening(raw, NOW + HOUR - 1)).toEqual({ kind: 'at', atMs: NOW + HOUR })
    expect(parseCachedOpening(raw, NOW + HOUR)).toEqual({ kind: 'soon' })
    expect(parseCachedOpening(raw, NOW + 2 * HOUR)).toEqual({ kind: 'soon' })
  })

  it('does not paint open or unknown, and drops stale, future-dated and malformed entries', () => {
    expect(parseCachedOpening(serializeOpening({ kind: 'open' }, NOW), NOW)).toBeNull()
    expect(parseCachedOpening(serializeOpening({ kind: 'unknown' }, NOW), NOW)).toBeNull()
    expect(parseCachedOpening(serializeOpening({ kind: 'soon' }, NOW), NOW + OPENING_CACHE_MAX_AGE_MS + 1)).toBeNull()
    expect(parseCachedOpening(serializeOpening({ kind: 'soon' }, NOW), NOW - 1)).toBeNull()
    for (const raw of [null, '', 'nope', '[]', 'null', '{}', JSON.stringify({ kind: 'at', savedAt: NOW }), JSON.stringify({ kind: 'at', atMs: 'x', savedAt: NOW }), JSON.stringify({ kind: 'soon' })]) {
      expect(parseCachedOpening(raw, NOW)).toBeNull()
    }
  })
})
