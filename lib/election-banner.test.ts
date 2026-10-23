import { describe, expect, it } from 'vitest'
import {
  ELECTIONS_CACHE_MAX_AGE_MS,
  bannerPhase,
  electionBanner,
  parseCachedElections,
  serializeElections,
  type PendingElection,
} from './election-banner'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const at = (ms: number) => `<${(ms - NOW) / HOUR}h>`

describe('bannerPhase', () => {
  it('maps every pre-seat stage of the Moderation teams page to a phase', () => {
    expect(bannerPhase({ kind: 'open' }, NOW)).toEqual({ kind: 'waiting', opensAtMs: null })
    expect(bannerPhase({ kind: 'not-open', opensAtMs: NOW + HOUR }, NOW)).toEqual({ kind: 'waiting', opensAtMs: NOW + HOUR })
    expect(bannerPhase({ kind: 'joining', joinClosesAtMs: NOW + HOUR, contenders: 1, votingEndsAtMs: NOW + 2 * HOUR }, NOW))
      .toEqual({ kind: 'applications', untilMs: NOW + HOUR, applicants: 1 })
    expect(bannerPhase({ kind: 'voting', votingEndsAtMs: NOW + 3 * HOUR, contenders: 2 }, NOW)).toEqual({ kind: 'voting', untilMs: NOW + 3 * HOUR })
    expect(bannerPhase({ kind: 'voting', votingEndsAtMs: null, contenders: 2 }, NOW)).toEqual({ kind: 'voting', untilMs: null })
    expect(bannerPhase({ kind: 'deciding' }, NOW)).toEqual({ kind: 'deciding' })
  })

  it('never says masternodes vote until a time that has passed', () => {
    expect(bannerPhase({ kind: 'voting', votingEndsAtMs: NOW, contenders: 2 }, NOW)).toEqual({ kind: 'deciding' })
  })

  it('announces nothing once seated or when a read failed', () => {
    expect(bannerPhase({ kind: 'seated' }, NOW)).toBeNull()
    expect(bannerPhase({ kind: 'unknown' }, NOW)).toBeNull()
  })
})

describe('electionBanner', () => {
  it('is null with nothing pending', () => {
    expect(electionBanner([])).toBeNull()
  })

  it('says what one election keeps closed and its phase, with a local time', () => {
    const say = (entry: PendingElection) => {
      const banner = electionBanner([entry], at)
      return banner && `${banner.headline}. ${banner.detail}`
    }
    expect(say({ contract: 'social', phase: { kind: 'waiting', opensAtMs: null } }))
      .toBe('Posting opens once moderators are elected. Waiting for a team to apply.')
    expect(say({ contract: 'social', phase: { kind: 'waiting', opensAtMs: NOW + HOUR } }))
      .toBe('Posting opens once moderators are elected. Teams can apply from <1h>.')
    expect(say({ contract: 'social', phase: { kind: 'applications', untilMs: NOW + 2 * HOUR, applicants: 1 } }))
      .toBe('Posting opens once moderators are elected. Applications close <2h>.')
    expect(say({ contract: 'blog', phase: { kind: 'voting', untilMs: NOW + 3 * HOUR } }))
      .toBe('Blogs open once moderators are elected. Masternodes are voting until <3h>.')
    expect(say({ contract: 'blog', phase: { kind: 'voting', untilMs: null } }))
      .toBe('Blogs open once moderators are elected. Masternodes are voting.')
    expect(say({ contract: 'storefront', phase: { kind: 'deciding' } }))
      .toBe('Stores open once moderators are elected. The new team starts shortly.')
  })

  it('links the vote only while masternodes vote, or will (two or more applicants)', () => {
    const vote = (phase: PendingElection['phase']) => electionBanner([{ contract: 'social', phase }], at)?.voteContract
    expect(vote({ kind: 'waiting', opensAtMs: null })).toBeNull()
    expect(vote({ kind: 'applications', untilMs: NOW + HOUR, applicants: 1 })).toBeNull()
    expect(vote({ kind: 'applications', untilMs: NOW + HOUR, applicants: 2 })).toBe('social')
    expect(vote({ kind: 'voting', untilMs: NOW + HOUR })).toBe('social')
    expect(vote({ kind: 'deciding' })).toBeNull()
  })

  it('sums several elections up in one line, naming contracts in the same phase together', () => {
    const banner = electionBanner([
      { contract: 'storefront', phase: { kind: 'waiting', opensAtMs: null } },
      { contract: 'social', phase: { kind: 'applications', untilMs: NOW + HOUR, applicants: 2 } },
      { contract: 'blog', phase: { kind: 'waiting', opensAtMs: null } },
    ], at)
    expect(banner).toMatchObject({
      headline: 'Social, Blogs and Stores: moderator elections in progress',
      detail: 'Social: applications close <1h>. Blogs and Stores: waiting for a team to apply.',
      teamsContract: 'social',
      voteContract: 'social',
    })
  })

  it('states a shared phase once, and leads to the election with most going on', () => {
    expect(electionBanner([
      { contract: 'blog', phase: { kind: 'waiting', opensAtMs: null } },
      { contract: 'storefront', phase: { kind: 'waiting', opensAtMs: null } },
    ], at)).toMatchObject({ headline: 'Blogs and Stores: moderator elections in progress', detail: 'Waiting for a team to apply.', teamsContract: 'blog', voteContract: null })
    expect(electionBanner([
      { contract: 'social', phase: { kind: 'applications', untilMs: NOW + HOUR, applicants: 1 } },
      { contract: 'storefront', phase: { kind: 'voting', untilMs: NOW + 2 * HOUR } },
    ], at)).toMatchObject({ teamsContract: 'storefront', voteContract: 'storefront' })
  })

  it('changes its signature whenever a phase or its date does', () => {
    const signature = (entries: PendingElection[]) => electionBanner(entries, at)?.signature
    const applying: PendingElection = { contract: 'social', phase: { kind: 'applications', untilMs: NOW + HOUR, applicants: 1 } }
    const base = signature([applying])
    expect(signature([applying])).toBe(base)
    expect(signature([{ contract: 'social', phase: { kind: 'applications', untilMs: NOW + 2 * HOUR, applicants: 1 } }])).not.toBe(base)
    expect(signature([{ contract: 'social', phase: { kind: 'voting', untilMs: NOW + HOUR } }])).not.toBe(base)
    expect(signature([applying, { contract: 'blog', phase: { kind: 'waiting', opensAtMs: null } }])).not.toBe(base)
  })
})

describe('remembered elections', () => {
  const pending: PendingElection[] = [
    { contract: 'social', phase: { kind: 'applications', untilMs: NOW + HOUR, applicants: 1 } },
    { contract: 'blog', phase: { kind: 'waiting', opensAtMs: null } },
  ]

  it('round-trips', () => {
    expect(parseCachedElections(serializeElections(pending, NOW), NOW + 1000)).toEqual(pending)
  })

  it('drops a deadline that has passed, and reads nothing too old, from the future or malformed', () => {
    const saved = serializeElections(pending, NOW)
    expect(parseCachedElections(saved, NOW + 2 * HOUR)).toEqual([pending[1]])
    expect(parseCachedElections(serializeElections([pending[0]], NOW), NOW + 2 * HOUR)).toBeNull()
    expect(parseCachedElections(saved, NOW + ELECTIONS_CACHE_MAX_AGE_MS + 1)).toBeNull()
    expect(parseCachedElections(saved, NOW - 1)).toBeNull()
    expect(parseCachedElections(null, NOW)).toBeNull()
    expect(parseCachedElections('not json', NOW)).toBeNull()
    expect(parseCachedElections(JSON.stringify({ savedAt: NOW, pending: [{ contract: 'dm', phase: { kind: 'deciding' } }] }), NOW)).toBeNull()
  })

  it('forgets an application date of the election delay once it has passed', () => {
    const raw = serializeElections([{ contract: 'social', phase: { kind: 'waiting', opensAtMs: NOW + HOUR } }], NOW)
    expect(parseCachedElections(raw, NOW + 2 * HOUR)).toEqual([{ contract: 'social', phase: { kind: 'waiting', opensAtMs: null } }])
  })
})
