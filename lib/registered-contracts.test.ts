import { describe, expect, it, vi } from 'vitest'
import {
  FEE_CHECK_FAILED, ensureRegisteredContract, indexLeadsOf, markRegisteredVerified, registeredActionFee, registeredContractOf, registeredDeleteWindow, registeredIndexLead, registeredOr, registeredOwnerProtected,
  registeredSettledRule, rememberRegisteredContract, trackRegisteredRefresh,
} from './registered-contracts'

/** A social v17 registered before D39/D41 (sakura, the retired staging rehearsal), the way the wasm `DataContract` exposes it: integers as bigints. */
const STAGING_SOCIAL = {
  schemas: {
    post: {
      actionFees: { pricing: 'feeMultiplier', create: { moderators: BigInt(80_000_000) } },
      moderatorAbilities: { delete: true, deleteWithin: BigInt(604_800), deleteSettled: { leader: true, approvals: BigInt(3) } },
    },
    report: { actionFees: { pricing: 'feeMultiplier', create: { moderators: BigInt(50_000_000) } }, moderatorAbilities: { delete: true } },
    follow: {},
  },
  config: { moderation: { moderators: { $type: 'elected', ownerProtected: true } } },
}

describe('registered contract declarations', () => {
  it('reads fees, windows, settled rules and owner protection off a fetched contract', () => {
    rememberRegisteredContract('staging-social', STAGING_SOCIAL)
    expect(registeredActionFee('staging-social', 'post', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
    expect(registeredActionFee('staging-social', 'post', 'replace')).toBeNull()
    expect(registeredActionFee('staging-social', 'follow', 'create')).toBeNull()
    expect(registeredDeleteWindow('staging-social', 'post')).toBe(604_800)
    expect(registeredDeleteWindow('staging-social', 'report')).toBeNull()
    expect(registeredSettledRule('staging-social', 'post')).toEqual({ windowSeconds: 604_800, leaderRequired: true, approvals: 3 })
    expect(registeredSettledRule('staging-social', 'report')).toBeNull()
    expect(registeredOwnerProtected('staging-social')).toBe(true)
  })

  it('answers undefined for what it has not seen, so the template answers', () => {
    expect(registeredActionFee('unknown', 'post', 'create')).toBeUndefined()
    rememberRegisteredContract('staging-social', STAGING_SOCIAL)
    expect(registeredActionFee('staging-social', 'storeItem', 'create')).toBeUndefined()
    expect(registeredOr(registeredDeleteWindow('staging-social', 'storeItem'), () => 86_400)).toBe(86_400)
    expect(registeredOr(registeredDeleteWindow('staging-social', 'report'), () => 86_400)).toBeNull()
  })

  it('keeps owner protection unknown off an elected declaration, forgets a contract that declares nothing, and keeps a record a failing read cannot replace', () => {
    expect(registeredContractOf({ schemas: {}, config: { moderation: { moderators: { $type: 'appointedModerators' } } } })?.ownerProtected).toBeNull()
    expect(registeredContractOf({})).toBeNull()
    rememberRegisteredContract('flaky', STAGING_SOCIAL)
    const throwing = { get schemas(): unknown { throw new Error('freed') }, config: undefined }
    rememberRegisteredContract('flaky', throwing)
    expect(registeredOwnerProtected('flaky')).toBe(true)
    rememberRegisteredContract('flaky', {})
    expect(registeredOwnerProtected('flaky')).toBeUndefined()
    expect(registeredActionFee('flaky', 'post', 'create')).toBeUndefined()
  })
})

describe('registered index shapes', () => {
  const repliesOf = (...properties: string[]) => ({ name: 'repliesOf', properties: properties.map((property) => ({ [property]: 'asc' })), rangeCountable: true })

  it('reads each index\'s first property, skipping entries it cannot read', () => {
    expect(indexLeadsOf([repliesOf('live', 'rootPostId'), { name: 'broken' }, { properties: [{ a: 'asc' }] }, null])).toEqual(new Map([['repliesOf', 'live']]))
    expect(indexLeadsOf(undefined)).toEqual(new Map())
  })

  it('answers the registered lead, null for an index the type lacks, and undefined for what it has not seen', () => {
    rememberRegisteredContract('earlier-v17', { schemas: { reply: { indices: [repliesOf('rootPostId', 'replyToReplyId', '$createdAt')] } } })
    rememberRegisteredContract('release-v17', { schemas: { reply: { indices: [repliesOf('live', 'rootPostId', 'replyToReplyId', '$createdAt')] } } })
    expect(registeredIndexLead('earlier-v17', 'reply', 'repliesOf')).toBe('rootPostId')
    expect(registeredIndexLead('release-v17', 'reply', 'repliesOf')).toBe('live')
    expect(registeredIndexLead('release-v17', 'reply', 'byRoot')).toBeNull()
    expect(registeredIndexLead('release-v17', 'post', 'repliesOf')).toBeUndefined()
    expect(registeredIndexLead('never-seen', 'reply', 'repliesOf')).toBeUndefined()
  })
})

describe('making a record proved before a priced write', () => {
  const declaring = (moderators: number) => ({ schemas: { post: { actionFees: { create: { moderators: BigInt(moderators) } } } } })

  it('reads nothing for a contract already read from the chain', async () => {
    rememberRegisteredContract('chain-read', declaring(5))
    const fetch = vi.fn()
    await ensureRegisteredContract('chain-read', fetch)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a contract the preload missed, and records it proved', async () => {
    const fetch = vi.fn(async () => declaring(50_000_000))
    await ensureRegisteredContract('missed-by-preload', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(registeredActionFee('missed-by-preload', 'post', 'create')?.moderators).toBe(50_000_000n)
    await ensureRegisteredContract('missed-by-preload', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits for the revalidation of a bundled seed and reads nothing once it is confirmed', async () => {
    rememberRegisteredContract('seeded', declaring(9), { seed: true })
    let confirm: () => void = () => undefined
    trackRegisteredRefresh(new Promise<void>((resolve) => { confirm = () => { markRegisteredVerified(['seeded']); resolve() } }))
    const fetch = vi.fn()
    const ensured = ensureRegisteredContract('seeded', fetch)
    confirm()
    await ensured
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a bundled seed whose revalidation failed or does not answer in time', async () => {
    rememberRegisteredContract('unconfirmed', declaring(9), { seed: true })
    trackRegisteredRefresh(Promise.reject(new Error('offline')))
    const fetch = vi.fn(async () => declaring(80_000_000))
    await ensureRegisteredContract('unconfirmed', fetch)
    expect(registeredActionFee('unconfirmed', 'post', 'create')?.moderators).toBe(80_000_000n)
    rememberRegisteredContract('slow', declaring(9), { seed: true })
    vi.useFakeTimers()
    try {
      trackRegisteredRefresh(new Promise(() => undefined))
      const slowFetch = vi.fn(async () => declaring(7))
      const ensured = ensureRegisteredContract('slow', slowFetch)
      await vi.advanceTimersByTimeAsync(10_000)
      await ensured
      expect(slowFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      trackRegisteredRefresh(Promise.resolve())
    }
  })

  it('fails before signing, saying nothing was sent, when the contract cannot be read', async () => {
    await expect(ensureRegisteredContract('unreadable', async () => null)).rejects.toThrow(FEE_CHECK_FAILED)
    await expect(ensureRegisteredContract('declares-nothing', async () => ({}))).rejects.toThrow(FEE_CHECK_FAILED)
    await expect(ensureRegisteredContract('offline', async () => { throw new Error('request timed out') })).rejects.toThrow(FEE_CHECK_FAILED)
  })

  it('keeps a chain-read record when an SDK rebuild seeds the bundle again', async () => {
    rememberRegisteredContract('reseeded', declaring(50_000_000))
    rememberRegisteredContract('reseeded', declaring(9), { seed: true })
    expect(registeredActionFee('reseeded', 'post', 'create')?.moderators).toBe(50_000_000n)
    const fetch = vi.fn()
    await ensureRegisteredContract('reseeded', fetch)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a missing record at once, without waiting for a revalidation in flight', async () => {
    trackRegisteredRefresh(new Promise(() => undefined))
    try {
      const fetch = vi.fn(async () => declaring(3))
      await ensureRegisteredContract('never-seeded', fetch)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      trackRegisteredRefresh(Promise.resolve())
    }
  })
})
