import { describe, expect, it } from 'vitest'
import {
  ELECTIONS_CACHE_MAX_AGE_MS,
  bannerPhase,
  electionBanner,
  mergeElectionAnswers,
  parseCachedElections,
  pendingElections,
  phaseAt,
  serializeElections,
  type ElectionAnswer,
  type ElectionSource,
  type PendingElection,
} from './election-banner'
import type { ModeratedContractKey } from './moderated-contracts'

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

describe('phaseAt', () => {
  it('moves a remembered phase on with the clock', () => {
    expect(phaseAt({ kind: 'applications', untilMs: NOW + HOUR, applicants: 1 }, NOW + 2 * HOUR)).toBeNull()
    expect(phaseAt({ kind: 'voting', untilMs: NOW + HOUR }, NOW + 2 * HOUR)).toEqual({ kind: 'deciding' })
    expect(phaseAt({ kind: 'voting', untilMs: null }, NOW)).toEqual({ kind: 'voting', untilMs: null })
    expect(phaseAt({ kind: 'waiting', opensAtMs: NOW + HOUR }, NOW + 2 * HOUR)).toEqual({ kind: 'waiting', opensAtMs: null })
    expect(phaseAt({ kind: 'deciding' }, NOW)).toEqual({ kind: 'deciding' })
    expect(phaseAt({ kind: 'nonsense' }, NOW)).toBeNull()
  })
})

describe('mergeElectionAnswers', () => {
  type Live = { id: string }
  const ALL: ModeratedContractKey[] = ['social', 'storefront', 'blog']
  const waiting: ElectionSource<Live> = { remembered: { kind: 'waiting', opensAtMs: null } }
  const merge = (
    answers: [ModeratedContractKey, ElectionAnswer<Live>][],
    previous: [ModeratedContractKey, ElectionSource<Live>][],
    settled: ModeratedContractKey[] = []
  ) => Object.fromEntries(mergeElectionAnswers(ALL, new Map(answers), new Map(previous), new Set(settled)))

  it('takes the election read this cycle over anything earlier', () => {
    expect(merge([['social', { id: 'new' }]], [['social', { live: { id: 'old' } }]])).toEqual({ social: { live: { id: 'new' } } })
  })

  it('keeps the earlier answer, live or remembered, where the read failed', () => {
    expect(merge([['social', 'failed'], ['blog', 'failed']], [['social', { live: { id: 'old' } }], ['blog', waiting]]))
      .toEqual({ social: { live: { id: 'old' } }, blog: waiting })
  })

  it('drops a contract that read open in the same cycle another failed, remembered or not', () => {
    expect(merge([['social', 'open'], ['blog', 'failed']], [['social', waiting], ['blog', waiting]], ['social'])).toEqual({ blog: waiting })
  })

  it('drops a contract settled open earlier and not read again', () => {
    expect(merge([], [['storefront', waiting]], ['storefront'])).toEqual({})
  })
})

describe('pendingElections', () => {
  it('derives live phases through the reader and re-derives remembered ones against the clock', () => {
    const sources = new Map<ModeratedContractKey, ElectionSource<string>>([
      ['social', { live: 'x' }],
      ['blog', { remembered: { kind: 'voting', untilMs: NOW + HOUR } }],
      ['storefront', { remembered: { kind: 'applications', untilMs: NOW + HOUR, applicants: 2 } }],
    ])
    expect(pendingElections(sources, NOW + 2 * HOUR, () => ({ kind: 'deciding' }))).toEqual([
      { contract: 'social', phase: { kind: 'deciding' } },
      { contract: 'blog', phase: { kind: 'deciding' } },
    ])
    expect(pendingElections(sources, NOW, () => null).map((entry) => entry.contract)).toEqual(['blog', 'storefront'])
  })
})
