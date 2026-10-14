import { describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { QUORUM_GAP_RETRY, installReadRetry, isRetriedRead, retryThroughQuorumGap, type RetryClock } from './sdk-read-retry'

/** What wasm-sdk 5.0.0-beta.6 throws while the quorum source lags a rotation. */
const quorumKeyUnavailable = () => ({
  name: 'Proof',
  kind: 4,
  code: -1,
  isRetriable: true,
  message: 'Proof verification error: quorum key unavailable for quorum 107:1c64a92f: invalid quorum: Quorum not found in cache for hash: 1c64a92f',
})

/** A clock whose sleeps only advance it, recording each one. */
function fakeClock(): RetryClock & { slept: number[] } {
  let now = 0
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms },
  }
}

describe('retryThroughQuorumGap', () => {
  it('repeats a read through the gap with backoff and returns its answer', async () => {
    const clock = fakeClock()
    const attempt = vi.fn()
      .mockRejectedValueOnce(quorumKeyUnavailable())
      .mockRejectedValueOnce(new Error(`no available addresses to retry, last error: ${quorumKeyUnavailable().message}`))
      .mockRejectedValueOnce(new Error('invalid quorum: Quorum not found in cache for hash: 00ab'))
      .mockResolvedValueOnce('profile')

    await expect(retryThroughQuorumGap(attempt, 'documents.get', QUORUM_GAP_RETRY, clock)).resolves.toBe('profile')
    expect(attempt.mock.calls.map(([n]) => n)).toEqual([0, 1, 2, 3])
    expect(clock.slept).toEqual([1_000, 2_000, 4_000])
  })

  it('gives up once the next attempt would start past the budget, with the last quorum error', async () => {
    const clock = fakeClock()
    const last = quorumKeyUnavailable()
    const attempt = vi.fn(async (n: number) => { throw n < 6 ? quorumKeyUnavailable() : last })

    await expect(retryThroughQuorumGap(attempt, 'identities.fetch', QUORUM_GAP_RETRY, clock)).rejects.toBe(last)
    // 1 + 2 + 4 + 4 + 4 + 4 = 19 s; a further 4 s would start past 20 s.
    expect(clock.slept).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000])
    expect(attempt).toHaveBeenCalledTimes(7)
  })

  it.each([
    ['an exhausted address pool', new Error('no available addresses to retry')],
    ['an unreachable quorum service (an outage, not a rotation)', new Error('Context provider error: quorum source unavailable: timeout')],
  ])('does not repeat %s', async (_label, failure) => {
    const clock = fakeClock()
    const attempt = vi.fn().mockRejectedValue(failure)

    await expect(retryThroughQuorumGap(attempt, 'documents.query', QUORUM_GAP_RETRY, clock)).rejects.toBe(failure)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })
})

describe('isRetriedRead', () => {
  const documents = { get: () => 0, getWithProof: () => 0, create: () => 0, replace: () => 0, query: () => 0, queryWithProof: () => 0 }

  it('takes a method with a proof sibling, or a proof method, for a read', () => {
    expect(isRetriedRead(documents, 'documents', 'get')).toBe(true)
    expect(isRetriedRead(documents, 'documents', 'queryWithProof')).toBe(true)
    expect(isRetriedRead({ resolveName: () => 0 }, 'dpns', 'resolveName')).toBe(true)
  })

  it('never takes a write for one', () => {
    expect(isRetriedRead(documents, 'documents', 'create')).toBe(false)
    expect(isRetriedRead(documents, 'documents', 'replace')).toBe(false)
    expect(isRetriedRead({ broadcastStateTransition: () => 0, waitForResponse: () => 0 }, 'stateTransitions', 'waitForResponse')).toBe(false)
    expect(isRetriedRead({ creditTransfer: () => 0, balance: () => 0, balanceWithProof: () => 0 }, 'identities', 'creditTransfer')).toBe(false)
  })
})

/** An SDK whose facades are plain objects of mocks; the rest are empty. */
function fakeSdk() {
  const documents = {
    get: vi.fn(),
    getWithProof: vi.fn(),
    create: vi.fn(),
  }
  const identities = { balance: vi.fn(), balanceWithProof: vi.fn(), creditTransfer: vi.fn() }
  return { documents, identities } as unknown as EvoSDK & { documents: typeof documents; identities: typeof identities }
}

describe('installReadRetry', () => {
  it('repeats a read on the current SDK instance, without nesting another retry', async () => {
    const clock = fakeClock()
    const old = fakeSdk()
    const rebuilt = fakeSdk()
    const oldGet = old.documents.get.mockRejectedValue(quorumKeyUnavailable())
    const newGet = rebuilt.documents.get
      .mockRejectedValueOnce(quorumKeyUnavailable())
      .mockResolvedValueOnce({ $id: 'doc' })
    installReadRetry(old, async () => rebuilt, QUORUM_GAP_RETRY, clock)
    installReadRetry(rebuilt, async () => rebuilt, QUORUM_GAP_RETRY, clock)

    await expect(old.documents.get('contract', 'post', 'doc')).resolves.toEqual({ $id: 'doc' })
    expect(oldGet).toHaveBeenCalledTimes(1)
    // Each repeat is one raw call: the rebuilt instance's own wrapper never ran its own retries.
    expect(newGet).toHaveBeenCalledTimes(2)
    expect(newGet).toHaveBeenLastCalledWith('contract', 'post', 'doc')
    expect(clock.slept).toEqual([1_000, 2_000])
  })

  it('falls back to the same instance when no current one can be had', async () => {
    const clock = fakeClock()
    const sdk = fakeSdk()
    sdk.identities.balance.mockRejectedValueOnce(quorumKeyUnavailable()).mockResolvedValueOnce(BigInt(5))
    installReadRetry(sdk, async () => { throw new Error('rebuild failed') }, QUORUM_GAP_RETRY, clock)

    await expect(sdk.identities.balance('id')).resolves.toBe(BigInt(5))
  })

  it('never repeats a write, whose result may have landed', async () => {
    const clock = fakeClock()
    const sdk = fakeSdk()
    const failure = quorumKeyUnavailable()
    const create = sdk.documents.create.mockRejectedValue(failure)
    const transfer = sdk.identities.creditTransfer.mockRejectedValue(failure)
    installReadRetry(sdk, async () => sdk, QUORUM_GAP_RETRY, clock)

    await expect(sdk.documents.create({})).rejects.toBe(failure)
    await expect(sdk.identities.creditTransfer({})).rejects.toBe(failure)
    expect(create).toHaveBeenCalledTimes(1)
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })
})
