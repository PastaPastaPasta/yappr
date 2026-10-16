import { describe, expect, it } from 'vitest'
import type { AppConnectIdentityKey, AppConnectSession, AppConnectSessionKey } from 'platform-auth'
import { appConnectStanding, reconcileSessionWithChain, withoutOutdatedEncryptionKeys } from './session-health'

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY
/** A grant of 100 units of 1e9 credits, so shares of it clear the budget floor. */
const UNIT = 1_000_000_000n
const health = (s: AppConnectSession) => appConnectStanding(s, NOW).health

function groupKey(overrides: Partial<AppConnectSessionKey> = {}): AppConnectSessionKey {
  return {
    keyId: 5,
    bounds: { kind: 'contractGroup', groupId: 'group' },
    securityLevel: 1,
    totalBudget: 100n * UNIT,
    remainingBudget: 50n * UNIT,
    expiresAt: NOW + 60 * DAY,
    keyRef: 'key-5',
    ...overrides,
  }
}

function session(authKeys: AppConnectSessionKey[] = [groupKey()]): AppConnectSession {
  return {
    v: 1, network: 'devnet', identityId: 'alice', appId: 'app', groupId: 'group', connectionId: '00'.repeat(16), grantedAt: 0,
    authKeys,
    encKeys: [{ keyId: 7, contractId: 'app', purpose: 1, keyRef: 'key-7' }],
  }
}

describe('appConnectStanding', () => {
  it('is ok with budget and time to spare', () => {
    expect(appConnectStanding(session(), NOW)).toEqual({ health: 'ok', renewSoon: null })
  })

  it('asks to renew soon under 20% of the allowance or 14 days, and says which', () => {
    expect(appConnectStanding(session([groupKey({ remainingBudget: 19n * UNIT })]), NOW)).toEqual({ health: 'renew-soon', renewSoon: 'allowance' })
    expect(health(session([groupKey({ remainingBudget: 20n * UNIT })]))).toBe('ok')
    expect(appConnectStanding(session([groupKey({ expiresAt: NOW + 13 * DAY })]), NOW)).toEqual({ health: 'renew-soon', renewSoon: 'expiry' })
  })

  it('asks to renew soon from sign-in when the whole grant is below the floor (#738)', () => {
    // Before the first budget read the grant counts as unspent: a tiny one is flagged at once, not at the first refused write.
    expect(appConnectStanding(session([groupKey({ totalBudget: 1000n, remainingBudget: undefined })]), NOW))
      .toEqual({ health: 'renew-soon', renewSoon: 'allowance' })
    expect(health(session([groupKey({ remainingBudget: undefined })]))).toBe('ok')
    expect(health(session([groupKey({ remainingBudget: UNIT - 1n })]))).toBe('renew-soon')
  })

  it('requires renewal when spent, expired, disabled or missing', () => {
    expect(health(session([groupKey({ remainingBudget: 0n })]))).toBe('renew-required')
    expect(health(session([groupKey({ expiresAt: NOW + 60_000 })]))).toBe('renew-required')
    expect(health(session([groupKey({ disabled: true })]))).toBe('renew-required')
    expect(health(session([]))).toBe('renew-required')
  })
})

describe('reconcileSessionWithChain', () => {
  const chain = (overrides: Partial<AppConnectIdentityKey> = {}): AppConnectIdentityKey[] => [
    { id: 5, type: 0, purpose: 0, securityLevel: 1, data: new Uint8Array(33), bounds: { kind: 'contractGroup', groupId: 'group' }, totalBudget: 100n, expiresAt: NOW + 60 * DAY, ...overrides },
    { id: 7, type: 0, purpose: 1, securityLevel: 3, data: new Uint8Array(33), bounds: { kind: 'singleContract', contractId: 'app' } },
  ]

  it('applies the chain budget', () => {
    const result = reconcileSessionWithChain(session(), chain(), new Map([[5, 12n]]))
    expect(result).toMatchObject({ revoked: false })
    if (!result.revoked) expect(result.session.authKeys[0].remainingBudget).toBe(12n)
  })

  it('keeps the cached budget when the read gave none', () => {
    const result = reconcileSessionWithChain(session(), chain(), new Map())
    if (!result.revoked) expect(result.session.authKeys[0].remainingBudget).toBe(50n * UNIT)
  })

  it('signs out when a key is disabled, gone, or no longer what the session recorded', () => {
    expect(reconcileSessionWithChain(session(), chain({ disabledAt: 1 }), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain().slice(1), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain().slice(0, 1), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain({ bounds: { kind: 'contractGroup', groupId: 'other' } }), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain({ securityLevel: 2 }), new Map()).revoked).toBe(true)
  })
})

describe('withoutOutdatedEncryptionKeys', () => {
  const chainKey = (id: number) => ({ id }) as AppConnectIdentityKey

  it('keeps the session when its encryption key is the current one', () => {
    expect(withoutOutdatedEncryptionKeys(session(), 'app', [chainKey(7)])).toBeNull()
  })

  it('drops an encryption key another wallet has replaced', () => {
    expect(withoutOutdatedEncryptionKeys(session(), 'app', [chainKey(9)])?.encKeys).toEqual([])
  })

  it('only judges keys bound to the given contract', () => {
    expect(withoutOutdatedEncryptionKeys(session(), 'other', [])).toBeNull()
  })
})
