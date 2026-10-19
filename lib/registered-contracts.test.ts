import { describe, expect, it } from 'vitest'
import {
  registeredActionFee, registeredContractOf, registeredDeleteWindow, registeredOr, registeredOwnerProtected, registeredSettledRule, rememberRegisteredContract,
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
