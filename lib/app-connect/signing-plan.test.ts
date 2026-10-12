import { describe, expect, it } from 'vitest'
import { selectSigningKey, type AppConnectSessionKey } from 'platform-auth'
import { documentSigningRequest, explainNoCoveringKey, rawSessionKey, tokenSigningRequest } from './signing-plan'

const NOW = 1_000_000_000
const ctx = { now: NOW, groups: [{ groupId: 'group', members: [{ kind: 'contract' as const, contractId: 'social' }] }] }

const groupKey = (overrides: Partial<AppConnectSessionKey> = {}): AppConnectSessionKey => ({
  keyId: 5, bounds: { kind: 'contractGroup', groupId: 'group' }, securityLevel: 2, totalBudget: 100n, remainingBudget: 50n, expiresAt: NOW + 86_400_000, keyRef: 'key-5', ...overrides,
})
const profileKey: AppConnectSessionKey = {
  keyId: 6, bounds: { kind: 'documentType', contractId: 'dashpay', documentTypeName: 'profile' }, securityLevel: 2, totalBudget: 10n, remainingBudget: 10n, expiresAt: NOW + 86_400_000, keyRef: 'key-6',
}

describe('the web signing requests', () => {
  it('route a DashPay profile write to the profile key and a Yappr write to the group key', () => {
    const keys = [groupKey(), profileKey]
    expect(selectSigningKey(keys, documentSigningRequest('dashpay', 'profile'), ctx)).toMatchObject({ ok: true, key: { keyId: 6 } })
    expect(selectSigningKey(keys, documentSigningRequest('social', 'post'), ctx)).toMatchObject({ ok: true, key: { keyId: 5 } })
    expect(selectSigningKey(keys, documentSigningRequest('elsewhere', 'post'), ctx)).toMatchObject({ ok: false })
  })

  it('needs a CRITICAL key for a token transition', () => {
    expect(selectSigningKey([groupKey()], tokenSigningRequest('social', 0), ctx)).toMatchObject({ ok: false })
    expect(selectSigningKey([groupKey({ securityLevel: 1 })], tokenSigningRequest('social', 0), ctx)).toMatchObject({ ok: true })
  })
})

describe('explainNoCoveringKey', () => {
  it('asks to renew when a covering key is spent or expired', () => {
    expect(explainNoCoveringKey([groupKey({ remainingBudget: 0n })], documentSigningRequest('social', 'post'), ctx)).toBe('renew')
    expect(explainNoCoveringKey([groupKey({ expiresAt: NOW })], documentSigningRequest('social', 'post'), ctx)).toBe('renew')
  })

  it('sends to the wallet when nothing covers the write, or the covering key was revoked', () => {
    expect(explainNoCoveringKey([groupKey()], documentSigningRequest('elsewhere', 'post'), ctx)).toBe('wallet')
    expect(explainNoCoveringKey([groupKey({ disabled: true })], documentSigningRequest('social', 'post'), ctx)).toBe('wallet')
    expect(explainNoCoveringKey([groupKey()], tokenSigningRequest('social', 0), ctx)).toBe('wallet')
  })
})

describe('rawSessionKey', () => {
  const base = { id: 3, type: 0, purpose: 0, securityLevel: 2, data: new Uint8Array(33) }

  it('skips the selector for an unbound key without limits (the legacy case)', () => {
    expect(rawSessionKey(base, undefined)).toBeNull()
  })

  it('makes a bound or limited raw key a one-key ring', () => {
    expect(rawSessionKey({ ...base, bounds: { kind: 'singleContract', contractId: 'social' } }, undefined))
      .toMatchObject({ keyId: 3, bounds: { kind: 'singleContract', contractId: 'social' }, keyRef: 'raw' })
    expect(rawSessionKey({ ...base, totalBudget: 9n }, 4n)).toMatchObject({ totalBudget: 9n, remainingBudget: 4n })
  })
})
