import { describe, expect, it } from 'vitest'
import type { AppConnectIdentityKey, AppConnectSession, AppConnectSessionKey } from 'platform-auth'
import { appConnectHealth, reconcileSessionWithChain } from './session-health'

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY

function groupKey(overrides: Partial<AppConnectSessionKey> = {}): AppConnectSessionKey {
  return {
    keyId: 5,
    bounds: { kind: 'contractGroup', groupId: 'group' },
    securityLevel: 1,
    totalBudget: 100n,
    remainingBudget: 50n,
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

describe('appConnectHealth', () => {
  it('is ok with budget and time to spare', () => {
    expect(appConnectHealth(session(), NOW)).toBe('ok')
  })

  it('asks to renew soon under 20% of the allowance or 14 days', () => {
    expect(appConnectHealth(session([groupKey({ remainingBudget: 19n })]), NOW)).toBe('renew-soon')
    expect(appConnectHealth(session([groupKey({ remainingBudget: 20n })]), NOW)).toBe('ok')
    expect(appConnectHealth(session([groupKey({ expiresAt: NOW + 13 * DAY })]), NOW)).toBe('renew-soon')
  })

  it('requires renewal when spent, expired, disabled or missing', () => {
    expect(appConnectHealth(session([groupKey({ remainingBudget: 0n })]), NOW)).toBe('renew-required')
    expect(appConnectHealth(session([groupKey({ expiresAt: NOW + 60_000 })]), NOW)).toBe('renew-required')
    expect(appConnectHealth(session([groupKey({ disabled: true })]), NOW)).toBe('renew-required')
    expect(appConnectHealth(session([]), NOW)).toBe('renew-required')
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
    if (!result.revoked) expect(result.session.authKeys[0].remainingBudget).toBe(50n)
  })

  it('signs out when a key is disabled, gone, or no longer what the session recorded', () => {
    expect(reconcileSessionWithChain(session(), chain({ disabledAt: 1 }), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain().slice(1), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain().slice(0, 1), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain({ bounds: { kind: 'contractGroup', groupId: 'other' } }), new Map()).revoked).toBe(true)
    expect(reconcileSessionWithChain(session(), chain({ securityLevel: 2 }), new Map()).revoked).toBe(true)
  })
})
