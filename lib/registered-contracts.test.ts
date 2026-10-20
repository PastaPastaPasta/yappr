import { describe, expect, it, vi } from 'vitest'
import {
  registeredActionFee, registeredContractOf, registeredContractsSettled, registeredDeleteWindow, registeredOr, registeredOwnerProtected, registeredSettledRule,
  rememberRegisteredContract, trackRegisteredRefresh,
} from './registered-contracts'

/** /staging's social v17 as registered (before D39/D41), the way the wasm `DataContract` exposes it: integers as bigints. */
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

describe('a refresh in flight', () => {
  it('holds a write until the snapshot check settles, so the refetched fee is the one agreed to', async () => {
    let finish: () => void = () => undefined
    trackRegisteredRefresh(new Promise<void>((resolve) => { finish = () => { rememberRegisteredContract('refreshed', { schemas: { post: { actionFees: { create: { moderators: BigInt(7) } } } } }); resolve() } }))
    const settled = registeredContractsSettled().then(() => registeredActionFee('refreshed', 'post', 'create')?.moderators)
    finish()
    await expect(settled).resolves.toBe(7n)
  })

  it('does not hold a write on a check that fails or never answers', async () => {
    trackRegisteredRefresh(Promise.reject(new Error('offline')))
    await expect(registeredContractsSettled()).resolves.toBeUndefined()
    vi.useFakeTimers()
    try {
      trackRegisteredRefresh(new Promise(() => undefined))
      const waiting = registeredContractsSettled()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(waiting).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
      trackRegisteredRefresh(Promise.resolve())
    }
  })
})
