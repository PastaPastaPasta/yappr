import { describe, expect, it } from 'vitest'
import {
  CHARTERS_CONTRACT_ID, CHARTER_LIMITS, CONTEST_FUND_CREDITS, DEFAULT_MODERATORS_SHARE, DEFAULT_REWARD_SPLIT,
  assertContestFund, charterTermsProblems, contestPhase, electionOpensAtMs, isCharterKey, joinClosesAtMs, messageProblem, reasonProblem, redactSecrets,
} from './rules.mjs'

const terms = (overrides: Partial<Parameters<typeof charterTermsProblems>[0]> = {}) => ({
  description: 'We hide spam and scams within a day of a report.',
  reasons: ['a'],
  moderatorsShare: DEFAULT_MODERATORS_SHARE,
  rewardSplit: { ...DEFAULT_REWARD_SPLIT },
  ...overrides,
})
const fields = (input: Parameters<typeof charterTermsProblems>[0]) => charterTermsProblems(input).map((problem) => problem.field)

describe('charter form validation', () => {
  it('accepts the defaults with a description and one reason', () => {
    expect(charterTermsProblems(terms())).toEqual([])
  })

  it('needs a reward split of whole percentages adding up to exactly 100', () => {
    expect(fields(terms({ rewardSplit: { leader: 100, equal: 0, actions: 0 } }))).toEqual([])
    expect(fields(terms({ rewardSplit: { leader: 0, equal: 0, actions: 100 } }))).toEqual([])
    const over = charterTermsProblems(terms({ rewardSplit: { leader: 50, equal: 30, actions: 30 } }))
    expect(over).toEqual([{ field: 'rewardSplit', message: expect.stringContaining('adds up to 110') }])
    expect(fields(terms({ rewardSplit: { leader: 40, equal: 30, actions: 29 } }))).toEqual(['rewardSplit'])
    expect(fields(terms({ rewardSplit: { leader: 40.5, equal: 29.5, actions: 30 } }))).toEqual(['rewardSplit'])
    expect(fields(terms({ rewardSplit: { leader: 120, equal: -20, actions: 0 } }))).toEqual(['rewardSplit'])
  })

  it("needs a moderators' share from 0 (a team that won't moderate) to 100", () => {
    expect(fields(terms({ moderatorsShare: 0 }))).toEqual([])
    expect(fields(terms({ moderatorsShare: 100 }))).toEqual([])
    for (const share of [-1, 101, 12.5, Number.NaN]) expect(fields(terms({ moderatorsShare: share }))).toEqual(['moderatorsShare'])
  })

  it('needs 1 to 64 distinct reasons: a team without one could never act', () => {
    expect(fields(terms({ reasons: [] }))).toEqual(['reasons'])
    expect(fields(terms({ reasons: Array.from({ length: CHARTER_LIMITS.reasons }, (_, i) => i) }))).toEqual([])
    expect(fields(terms({ reasons: Array.from({ length: CHARTER_LIMITS.reasons + 1 }, (_, i) => i) }))).toEqual(['reasons'])
    expect(fields(terms({ reasons: ['a', 'a'] }))).toEqual(['reasons'])
    expect(charterTermsProblems(terms({ reasons: [{ code: 'SPM' }, { code: 'SPM' }] }), (reason) => (reason as { code: string }).code)[0]?.field).toBe('reasons')
  })

  it("holds the description to the schema's 4096 bytes, counting UTF-8 bytes, not characters", () => {
    expect(fields(terms({ description: 'a'.repeat(4096) }))).toEqual([])
    expect(fields(terms({ description: 'a'.repeat(4097) }))).toEqual(['description'])
    // 1,024 emoji are 1,024 characters but 4,096 bytes; one more is over.
    expect(fields(terms({ description: '🙂'.repeat(1024) }))).toEqual([])
    expect(fields(terms({ description: '🙂'.repeat(1025) }))).toEqual(['description'])
    expect(fields(terms({ description: '   ' }))).toEqual(['description'])
  })

  it('lists every problem in form order', () => {
    expect(fields({ description: '', reasons: [], moderatorsShare: 101, rewardSplit: { leader: 1, equal: 1, actions: 1 } }))
      .toEqual(['description', 'reasons', 'moderatorsShare', 'rewardSplit'])
  })

  it('checks a reason: a three-capital-letter code, a 1 to 64 character label, an optional 1 to 1024 character description', () => {
    expect(reasonProblem({ code: 'SPM', label: 'Spam' })).toBeNull()
    expect(reasonProblem({ code: 'SPM', label: 'Spam', description: 'x'.repeat(1024) })).toBeNull()
    expect(reasonProblem({ code: 'spm', label: 'Spam' })?.field).toBe('code')
    expect(reasonProblem({ code: 'SPAM', label: 'Spam' })?.field).toBe('code')
    expect(reasonProblem({ code: 'SPM', label: ' ' })?.field).toBe('label')
    expect(reasonProblem({ code: 'SPM', label: '🙂'.repeat(64) })).toBeNull()
    expect(reasonProblem({ code: 'SPM', label: 'x'.repeat(65) })?.field).toBe('label')
    expect(reasonProblem({ code: 'SPM', label: 'Spam', description: '' })?.field).toBe('description')
    expect(reasonProblem({ code: 'SPM', label: 'Spam', description: 'x'.repeat(1025) })?.field).toBe('description')
  })

  it('holds a join message to 1023 bytes before encryption', () => {
    expect(messageProblem('')).toBeNull()
    expect(messageProblem('x'.repeat(1023))).toBeNull()
    expect(messageProblem('x'.repeat(1024))).toMatch(/1023 bytes/)
    expect(messageProblem('é'.repeat(512))).toMatch(/1023 bytes/)
  })
})

describe('charter keys and the contest', () => {
  const bound = (purpose: string, documentTypeName: string, extra: Record<string, unknown> = {}) => ({
    purpose, securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1',
    contractBounds: { toJSON: () => ({ $type: 'documentType', id: CHARTERS_CONTRACT_ID, documentTypeName }) }, ...extra,
  })

  it('recognises only an enabled MEDIUM secp256k1 key bound to the charters document type', () => {
    expect(isCharterKey(bound('DECRYPTION', 'submittedCharter'), 'DECRYPTION', 'submittedCharter')).toBe(true)
    expect(isCharterKey(bound('ENCRYPTION', 'joinRequest'), 'ENCRYPTION', 'joinRequest')).toBe(true)
    expect(isCharterKey(bound('ENCRYPTION', 'submittedCharter'), 'ENCRYPTION', 'joinRequest')).toBe(false)
    expect(isCharterKey(bound('ENCRYPTION', 'joinRequest', { disabledAt: 5 }), 'ENCRYPTION', 'joinRequest')).toBe(false)
    expect(isCharterKey(bound('ENCRYPTION', 'joinRequest', { securityLevel: 'HIGH' }), 'ENCRYPTION', 'joinRequest')).toBe(false)
    expect(isCharterKey({ ...bound('ENCRYPTION', 'joinRequest'), contractBounds: null }, 'ENCRYPTION', 'joinRequest')).toBe(false)
  })

  it('opens applications at creation plus the election delay', () => {
    expect(electionOpensAtMs(1_000, 60)).toBe(61_000)
    expect(electionOpensAtMs(1_000, -1)).toBeNull()
    expect(electionOpensAtMs(Number.NaN, 60)).toBeNull()
  })

  it('reads join close off the poll end: a second applicant moves the end out by the vote window', () => {
    expect(joinClosesAtMs(10_000_000, 1, 3600)).toBe(10_000_000)
    expect(joinClosesAtMs(10_000_000, 2, 3600)).toBe(6_400_000)
    expect(joinClosesAtMs(null, 2, 3600)).toBeNull()
  })

  it('names the contest phase', () => {
    const base = { seated: false, decided: false, contenders: 1, joinClosesAtMs: 100, chainTimeMs: 50 }
    expect(contestPhase(base)).toBe('joining')
    expect(contestPhase({ ...base, chainTimeMs: 100 })).toBe('voting')
    expect(contestPhase({ ...base, contenders: 0 })).toBe('none')
    expect(contestPhase({ ...base, joinClosesAtMs: null })).toBe('unknown')
    expect(contestPhase({ ...base, decided: true })).toBe('decided')
    expect(contestPhase({ ...base, seated: true, decided: true })).toBe('seated')
  })

  it('accepts only the reviewed 0.5 DASH contest fund', () => {
    expect(() => assertContestFund(CONTEST_FUND_CREDITS)).not.toThrow()
    expect(() => assertContestFund(10_000_000_000n)).toThrow('0.5 DASH')
    expect(() => assertContestFund(undefined)).toThrow('0.5 DASH')
  })

  it('blanks anything shaped like a private key in an error', () => {
    const wif = 'cN3fEEyFJKaKRWzQhkyP8Uq1XU3AJrM6tN3pCKqZQxnJcrJzfu8X'
    expect(redactSecrets(`bad key ${wif} and ${'ab'.repeat(32)}`)).toBe('bad key [redacted key] and [redacted hex]')
  })
})
