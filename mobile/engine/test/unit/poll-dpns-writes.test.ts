/**
 * Poll ballots (`posts.vote`) and DPNS registration (`dpns.*`), with lib's
 * services mocked: each regime's ticket mapping, the refusals the host
 * words (BAD_REQUEST), and the "check again" probes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  viewer: 'V' as string | null,
  mode: 'editable' as 'editable' | 'once' | null,
  pollService: { fetchPoll: vi.fn() },
  voteService: { setVote: vi.fn(), castVote: vi.fn(), getMyVotes: vi.fn() },
  dpns: {
    getUsernameValidationError: vi.fn((label: string): string | null => (label.length < 3 ? 'Username must be at least 3 characters long' : null)),
    registerUsername: vi.fn(),
    findIdentityByName: vi.fn(),
    quoteName: vi.fn(),
    clearCache: vi.fn(),
  },
  sdk: {
    dpns: { isValidUsername: vi.fn(async () => true), isNameAvailable: vi.fn(async () => true), isContestedUsername: vi.fn(async () => false) },
    epoch: { current: vi.fn(async () => ({ protocolVersion: 14 })) },
  },
  identity: { getIdentity: vi.fn() },
  privateKey: 'WIF' as string | null,
  appConnect: false,
  match: vi.fn(),
  refreshUsername: vi.fn(async () => undefined),
}))

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/services/pollr-poll-service', async (load) => ({ ...await load<object>(), pollrPollService: m.pollService }))
vi.mock('@/lib/services/pollr-vote-service', async (load) => ({ ...await load<object>(), pollrVoteService: m.voteService }))
vi.mock('../../src/dto/capabilities', async (load) => ({ ...await load<object>(), pollVoting: () => m.mode }))
vi.mock('@/lib/services/dpns-service', async (load) => ({ ...await load<object>(), dpnsService: m.dpns }))
vi.mock('@/lib/services/evo-sdk-service', async (load) => ({ ...await load<object>(), getEvoSdk: async () => m.sdk }))
vi.mock('@/lib/services/identity-service', async (load) => ({ ...await load<object>(), identityService: m.identity }))
vi.mock('@/lib/secure-storage', async (load) => ({ ...await load<object>(), getPrivateKey: () => m.privateKey }))
vi.mock('@/lib/auth/signing-keys', async (load) => ({ ...await load<object>(), hasAppConnectSession: () => m.appConnect }))
vi.mock('@/lib/crypto/keys', async (load) => ({ ...await load<object>(), matchIdentityKey: m.match }))

const { createTicketStore } = await import('../../src/writes/tickets')
const { createPollWrites } = await import('../../src/api/posts')
const { createDpnsModule } = await import('../../src/api/dpns')
type WriteTicket = import('../../src/writes/types').WriteTicket

const id = (tag: string) => tag.replace(/[0OIl]/g, 'z').padEnd(44, 'x')
const VIEWER = id('Viewer')
const POLL = id('Poll')
const DAY = 24 * 60 * 60 * 1000
const poll = (extra: Record<string, unknown> = {}) => ({
  id: POLL, ownerId: id('Owner'), question: 'Q', options: ['a', 'b', 'c'], multiChoice: false, endsAt: Date.now() + DAY, ...extra,
})

function engine() {
  const items = new Map<string, string>()
  let elapsed = 0
  const tickets = createTicketStore({
    now: () => Date.now() + elapsed,
    storage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } },
    emit: () => undefined,
    currentIdentity: () => m.viewer,
    documentExists: async () => true,
    absenceRecheckMs: 0,
    autoRetryDelaysMs: [],
  })
  const outcome = (submitted: Promise<WriteTicket>) => submitted.then(ticket => vi.waitFor(() => {
    const current = tickets.get(ticket.id)
    if (!current || current.state === 'pending') throw new Error('still pending')
    return current
  }, { timeout: 5_000, interval: 5 }))
  return {
    tickets,
    outcome,
    /** Moves the store's clock on (past `ABSENCE_AFTER_MS`, so a check may call a write absent). */
    elapse: (ms: number) => { elapsed += ms },
    polls: createPollWrites(tickets),
    dpns: createDpnsModule(tickets, { refreshUsername: m.refreshUsername }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.viewer = VIEWER
  m.mode = 'editable'
  m.privateKey = 'WIF'
  m.appConnect = false
  m.pollService.fetchPoll.mockResolvedValue(poll())
  m.identity.getIdentity.mockResolvedValue({ id: VIEWER, balance: 10 ** 12, publicKeys: [] })
  m.match.mockReturnValue({ ok: true, key: { id: 1 }, match: { keyId: 1, securityLevel: 2 } })
  m.sdk.dpns.isNameAvailable.mockResolvedValue(true)
  m.sdk.dpns.isContestedUsername.mockResolvedValue(false)
  // lib's quote: the deposit of a contested name (0.1 DASH at protocol 14) and both fees.
  m.dpns.quoteName.mockImplementation(async (label: string) => ({
    label,
    contestFund: (await m.sdk.dpns.isContestedUsername()) ? { indexName: 'parentNameAndLabel', credits: 10_000_000_000n } : null,
    fees: 70_000_000n,
  }))
})

describe('posts.vote', () => {
  it('sets an editable ballot, withdraws it, and words the refusals before anything is sent', async () => {
    const { polls, outcome } = engine()
    m.voteService.setVote.mockResolvedValue({ success: true, choices: [1], closed: false, stale: false })
    expect(await outcome(polls.vote(POLL, [1]))).toMatchObject({ op: 'poll.vote', state: 'confirmed' })
    expect(m.voteService.setVote).toHaveBeenCalledWith(expect.objectContaining({ id: POLL }), [1], VIEWER)
    expect(await outcome(polls.vote(POLL, []))).toMatchObject({ state: 'confirmed' })
    expect(m.voteService.setVote).toHaveBeenLastCalledWith(expect.anything(), [], VIEWER)

    m.voteService.setVote.mockResolvedValue({ success: false, heldBack: true, closed: false, stale: false, error: 'An earlier vote is still being confirmed' })
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: expect.stringContaining('still being confirmed') } })

    m.voteService.setVote.mockResolvedValue({ success: false, unconfirmed: true, closed: false, stale: false, error: 'timeout' })
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'unconfirmed' })

    m.pollService.fetchPoll.mockResolvedValue(poll({ endsAt: Date.now() - 1000 }))
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: 'This poll has closed.' } })
    m.pollService.fetchPoll.mockResolvedValue(null)
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: 'This poll is no longer available.' } })
    m.pollService.fetchPoll.mockResolvedValue(poll())
    expect(await outcome(polls.vote(POLL, [3]))).toMatchObject({ state: 'failed', error: { userMessage: 'That is not an option of this poll.' } })

    // lib's own sentences never reach the user; a refusal it proved final is worded here.
    m.voteService.setVote.mockResolvedValue({ success: false, choices: [0], closed: false, stale: false, error: 'wasm: revision 3 != 4' })
    expect(await outcome(polls.vote(POLL, [1]))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: "Your vote wasn't saved. Try again." } })
  })

  it('keeps Platform refusals the host acts on (credits, a revoked key) and names the poll on the ticket', async () => {
    const { polls, outcome } = engine()
    m.voteService.setVote.mockResolvedValue({ success: false, choices: [], closed: false, stale: false, error: 'Identity insufficient identity credit balance: credits balance 10 is not enough to pay 900' })
    expect(await outcome(polls.vote(POLL, [1]))).toMatchObject({ state: 'failed', target: { pollId: POLL }, error: { code: 'INSUFFICIENT_CREDITS' } })
    m.voteService.setVote.mockResolvedValue({ success: false, choices: [], closed: false, stale: false, error: 'Identity key 2 is disabled' })
    expect(await outcome(polls.vote(POLL, [1]))).toMatchObject({ state: 'failed', error: { code: 'KEY_REVOKED' } })
  })

  it('fails a vote whose poll or ballot read failed as not sent and retryable, never "poll gone"', async () => {
    const { polls, outcome } = engine()
    m.pollService.fetchPoll.mockRejectedValue(new Error('no available addresses to retry'))
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK' } })
    expect(m.voteService.setVote).not.toHaveBeenCalled()

    m.pollService.fetchPoll.mockResolvedValue(poll())
    m.voteService.setVote.mockResolvedValue({ success: false, closed: false, stale: false, error: "Couldn't read your ballot: no available addresses to retry" })
    expect(await outcome(polls.vote(POLL, [0]))).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK' } })
  })

  it('casts one final ballot where ballots are immutable (v3), and says when one was already cast', async () => {
    const { polls, outcome } = engine()
    m.mode = 'once'
    m.voteService.castVote.mockResolvedValue({ success: true, created: [2], alreadyVoted: [], unresolvedDuplicate: false, failed: [] })
    m.voteService.getMyVotes.mockResolvedValueOnce([2])
    expect(await outcome(polls.vote(POLL, [2]))).toMatchObject({ state: 'confirmed' })
    expect(m.voteService.setVote).not.toHaveBeenCalled()

    // Cast, but not read back yet (a confirmation wait that timed out): unconfirmed, for the probe.
    m.voteService.getMyVotes.mockResolvedValueOnce([])
    expect(await outcome(polls.vote(POLL, [2]))).toMatchObject({ state: 'unconfirmed' })
    m.voteService.getMyVotes.mockRejectedValueOnce(new Error('Request timeout'))
    expect(await outcome(polls.vote(POLL, [2]))).toMatchObject({ state: 'unconfirmed' })

    // Multiple choice: another device added option 0 since this one read the ballot; option 1 still landed.
    m.pollService.fetchPoll.mockResolvedValue(poll({ multiChoice: true }))
    m.voteService.castVote.mockResolvedValue({ success: true, created: [1], alreadyVoted: [], unresolvedDuplicate: false, failed: [] })
    m.voteService.getMyVotes.mockResolvedValueOnce([0, 1])
    expect(await outcome(polls.vote(POLL, [1]))).toMatchObject({ state: 'confirmed' })

    m.voteService.castVote.mockResolvedValue({ success: true, created: [], alreadyVoted: [0], unresolvedDuplicate: false, failed: [] })
    expect(await outcome(polls.vote(POLL, [2]))).toMatchObject({ state: 'failed', error: { userMessage: 'You already voted in this poll.' } })

    await expect(polls.vote(POLL, [])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses bad input, read-only polls and signed-out voters before a ticket', async () => {
    const { polls } = engine()
    await expect(polls.vote(POLL, [1, 1])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(polls.vote(POLL, [-1])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(polls.vote('bad', [0])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.mode = null
    await expect(polls.vote(POLL, [0])).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    m.viewer = null
    await expect(polls.vote(POLL, [0])).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  })

  it('checks a ballot whose outcome is unknown by reading the voter back', async () => {
    const { polls, outcome, tickets } = engine()
    m.pollService.fetchPoll.mockResolvedValue(poll({ multiChoice: true }))
    m.voteService.setVote.mockResolvedValue({ success: false, unconfirmed: true, closed: false, stale: false, error: 'timeout' })
    const ticket = await outcome(polls.vote(POLL, [2, 0]))
    expect(ticket.state).toBe('unconfirmed')
    m.voteService.getMyVotes.mockResolvedValue([0, 2])
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
  })
})

describe('dpns', () => {
  it('registers here with an unbound HIGH or CRITICAL key, and in the wallet otherwise', async () => {
    const { dpns } = engine()
    expect(await dpns.registration()).toBe('native')
    m.match.mockReturnValue({ ok: true, key: { id: 1, contractBounds: { contractId: 'x' } }, match: { keyId: 1, securityLevel: 2 } })
    expect(await dpns.registration()).toBe('wallet')
    m.match.mockReturnValue({ ok: false, reason: 'no-match' })
    expect(await dpns.registration()).toBe('wallet')
    m.appConnect = true
    expect(await dpns.registration()).toBe('wallet')
    m.appConnect = false
    m.privateKey = null
    expect(await dpns.registration()).toBe('wallet')
    m.privateKey = 'WIF'
    m.identity.getIdentity.mockRejectedValue(new Error('no available addresses to retry'))
    await expect(dpns.registration()).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('checks a name: invalid, taken, contested with its fund, and never "taken" when the read fails', async () => {
    const { dpns } = engine()
    expect(await dpns.check('@Alice.dash')).toEqual({ label: 'alice', available: true, contested: false, contestFundCredits: null, invalid: null })
    expect(await dpns.check('ab')).toMatchObject({ available: false, invalid: 'Username must be at least 3 characters long' })
    m.sdk.dpns.isNameAvailable.mockResolvedValueOnce(false)
    expect(await dpns.check('alice')).toMatchObject({ available: false, invalid: null })
    m.sdk.dpns.isContestedUsername.mockResolvedValue(true)
    // The deposit its vote takes now, as lib quotes it.
    expect(await dpns.check('bob')).toMatchObject({ available: true, contested: true, contestFundCredits: 10_000_000_000n })
    expect(m.dpns.quoteName).toHaveBeenCalledWith('bob', VIEWER)
    m.sdk.dpns.isContestedUsername.mockResolvedValue(false)
    m.sdk.dpns.isNameAvailable.mockRejectedValueOnce(new Error('Request timeout'))
    await expect(dpns.check('alice')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('registers, reads the names again, and refuses a taken name or an unaffordable contest in its own words', async () => {
    const { dpns, outcome } = engine()
    m.dpns.registerUsername.mockResolvedValue({ state: 'registered' })
    expect(await outcome(dpns.register(' NewName '))).toMatchObject({ op: 'dpns.register', state: 'confirmed' })
    expect(m.dpns.registerUsername).toHaveBeenCalledWith('newname', VIEWER, 'WIF', { contestFund: null })
    expect(m.refreshUsername).toHaveBeenCalled()

    m.sdk.dpns.isNameAvailable.mockResolvedValueOnce(false)
    m.dpns.findIdentityByName.mockResolvedValueOnce('someone-else')
    expect(await outcome(dpns.register('taken'))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: 'taken is already taken.' } })

    // The deposit and both fees must fit the balance: 0.1 DASH plus fees is more than 0.1 DASH.
    m.sdk.dpns.isContestedUsername.mockResolvedValue(true)
    m.identity.getIdentity.mockResolvedValue({ id: VIEWER, balance: 10_000_000_000, publicKeys: [] })
    expect(await outcome(dpns.register('bob', 10_000_000_000n))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: expect.stringContaining('too low') } })
    expect(m.dpns.registerUsername).toHaveBeenCalledTimes(1)

    m.appConnect = true
    expect(await outcome(dpns.register('walletname'))).toMatchObject({ state: 'failed', error: { code: 'NOT_SUPPORTED' } })
    await expect(dpns.register('  ')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('checks a registration whose outcome is unknown by resolving the name', async () => {
    const { dpns, outcome, tickets } = engine()
    m.dpns.registerUsername.mockRejectedValue(new Error('Request timeout'))
    const ticket = await outcome(dpns.register('newname'))
    expect(ticket.state).toBe('unconfirmed')
    expect(m.refreshUsername).not.toHaveBeenCalled()
    m.dpns.findIdentityByName.mockResolvedValue(VIEWER)
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
    expect(m.dpns.findIdentityByName).toHaveBeenCalledWith('newname')
    // Confirmed by the check: the session reads its names again too.
    expect(m.refreshUsername).toHaveBeenCalledTimes(1)
  })

  it('never offers a retry for a contested name it cannot prove, which would pay a second preorder', async () => {
    const { dpns, outcome, tickets, elapse } = engine()
    m.sdk.dpns.isContestedUsername.mockResolvedValue(true)
    m.dpns.registerUsername.mockRejectedValue(new Error('Request timeout'))
    const ticket = await outcome(dpns.register('bob'))
    expect(ticket.state).toBe('unconfirmed')
    m.dpns.findIdentityByName.mockResolvedValue(null)
    elapse(10 * 60_000)
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'unconfirmed', retryable: false })
  })

  it('fails a registration lib refused before sending (its own reads) as not sent, even for a contested name', async () => {
    const { DpnsNotSentError } = await import('@/lib/services/dpns-registration')
    const { dpns, outcome } = engine()
    m.sdk.dpns.isContestedUsername.mockResolvedValue(true)
    m.dpns.registerUsername.mockRejectedValue(new DpnsNotSentError(new Error('no available addresses to retry')))
    expect(await outcome(dpns.register('bob'))).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK' } })
  })

  it('caps a contested registration at the deposit the host showed, and words a changed deposit', async () => {
    const { DpnsNotSentError } = await import('@/lib/services/dpns-registration')
    const { ContestFundChangedError } = await import('@/lib/dpns/registration-quote')
    const { dpns, outcome } = engine()
    m.sdk.dpns.isContestedUsername.mockResolvedValue(true)
    m.dpns.registerUsername.mockResolvedValue({ state: 'joined-vote' })
    expect(await outcome(dpns.register('bob', 10_000_000_000n))).toMatchObject({ state: 'confirmed' })
    expect(m.dpns.registerUsername).toHaveBeenLastCalledWith('bob', VIEWER, 'WIF', { contestFund: 10_000_000_000n })

    const changed = new ContestFundChangedError('bob', 10_000_000_000n, 20_000_000_000n)
    m.dpns.registerUsername.mockRejectedValue(new DpnsNotSentError(changed))
    expect(await outcome(dpns.register('bob', 10_000_000_000n))).toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: changed.message } })
  })

  it('leaves a registration lib reports pending unconfirmed, and lets a name the account already holds through', async () => {
    const { dpns, outcome } = engine()
    m.dpns.registerUsername.mockResolvedValue({ state: 'pending', step: 'preorder' })
    expect(await outcome(dpns.register('newname'))).toMatchObject({ state: 'unconfirmed' })

    // Its domain landed after the answer was lost: not "taken", the run reports it registered.
    m.sdk.dpns.isNameAvailable.mockResolvedValueOnce(false)
    m.dpns.findIdentityByName.mockResolvedValueOnce(VIEWER)
    m.dpns.registerUsername.mockResolvedValue({ state: 'registered' })
    expect(await outcome(dpns.register('newname'))).toMatchObject({ state: 'confirmed' })
  })

  it('fails a registration whose checks could not be read as not sent and retryable', async () => {
    const { dpns, outcome } = engine()
    m.sdk.dpns.isNameAvailable.mockRejectedValueOnce(new Error('no available addresses to retry'))
    expect(await outcome(dpns.register('newname'))).toMatchObject({ state: 'failed', retryable: true, error: { code: 'NETWORK' } })
    expect(m.dpns.registerUsername).not.toHaveBeenCalled()
  })
})
