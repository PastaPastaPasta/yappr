import { describe, expect, it } from 'vitest'
import {
  buildAppConnectSession,
  selectSigningKey,
  type AppConnectSessionKey,
  type PinnedGroup,
  type SigningMember,
  type SigningRequest,
} from './session'
import { KeyPurpose, KeySecurityLevel, KeyType } from './types'
import type { AppConnectGrant } from './verify'

const GROUP = 'GroupId1111111111111111111111111111111111111'
const SOCIAL = 'Social11111111111111111111111111111111111111'
const DM = 'Dm1111111111111111111111111111111111111111111'
const BLOG = 'Blog111111111111111111111111111111111111111'
const SHOP = 'Shop111111111111111111111111111111111111111'
const DASHPAY = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
const KEY_EXCHANGE = 'KeyExchange111111111111111111111111111111111'
const NOW = 1_800_000_000_000

const groups: PinnedGroup[] = [{
  groupId: GROUP,
  members: [
    { kind: 'contract', contractId: SOCIAL },
    { kind: 'contract', contractId: DM },
    { kind: 'documentType', contractId: BLOG, documentTypeName: 'post' },
    { kind: 'token', contractId: SHOP, position: 0 },
  ],
}]

function key(keyId: number, overrides: Partial<AppConnectSessionKey>): AppConnectSessionKey {
  return { keyId, securityLevel: KeySecurityLevel.HIGH, keyRef: `ref-${keyId}`, ...overrides }
}

const groupKey = key(5, {
  bounds: { kind: 'contractGroup', groupId: GROUP },
  securityLevel: KeySecurityLevel.CRITICAL,
  totalBudget: 50_000_000_000n,
  remainingBudget: 40_000_000_000n,
  expiresAt: NOW + 30 * 86_400_000,
})
const profileKey = key(6, {
  bounds: { kind: 'documentType', contractId: DASHPAY, documentTypeName: 'profile' },
  totalBudget: 1_000_000_000n,
  remainingBudget: 900_000_000n,
  expiresAt: NOW + 30 * 86_400_000,
})
const ring = [groupKey, profileKey]

const doc = (contractId: string, documentType: string): SigningMember => ({ contractId, documentType })
const token = (contractId: string, tokenPosition: number): SigningMember => ({ contractId, tokenPosition })
const batch = (...members: SigningMember[]): SigningRequest => ({ transition: 'batch', members })

function chosen(keys: AppConnectSessionKey[], request: SigningRequest, now = NOW): number | string {
  const result = selectSigningKey(keys, request, { now, groups })
  return result.ok ? result.key.keyId : result.reason
}

describe('selectSigningKey', () => {
  it('signs Yappr writes with the group key and DashPay profile writes with the profile key', () => {
    expect(chosen(ring, batch(doc(SOCIAL, 'post')))).toBe(5)
    expect(chosen(ring, batch(doc(DM, 'message'), doc(SOCIAL, 'like')))).toBe(5)
    expect(chosen(ring, batch(doc(DASHPAY, 'profile')))).toBe(6)
  })

  it('never routes a write no key covers (no paid 20014)', () => {
    expect(chosen(ring, batch(doc(DASHPAY, 'contactRequest')))).toBe('no-covering-key')
    expect(chosen(ring, batch(doc(KEY_EXCHANGE, 'loginKey')))).toBe('no-covering-key')
    expect(chosen(ring, batch(doc(BLOG, 'comment')))).toBe('no-covering-key')
    expect(chosen(ring, batch(doc(BLOG, 'post')))).toBe(5)
  })

  it('only trusts pinned membership for a group key', () => {
    const otherGroup = key(9, { bounds: { kind: 'contractGroup', groupId: 'Other1111111111111111111111111111111111111' } })
    expect(chosen([otherGroup], batch(doc(SOCIAL, 'post')))).toBe('no-covering-key')
  })

  it('never uses a bound key for a non-batch transition', () => {
    expect(chosen(ring, { transition: 'non-batch', members: [] })).toBe('non-batch')
    const rawKey = key(1, { securityLevel: KeySecurityLevel.CRITICAL })
    expect(chosen([...ring, rawKey], { transition: 'non-batch', members: [], requiredSecurityLevel: KeySecurityLevel.CRITICAL })).toBe(1)
  })

  it('requires CRITICAL for token operations', () => {
    expect(chosen(ring, batch(token(SOCIAL, 0)))).toBe(5)
    expect(chosen(ring, batch(token(DM, 0), doc(DM, 'message')))).toBe(5)
    const highGroup = { ...groupKey, securityLevel: KeySecurityLevel.HIGH }
    expect(chosen([highGroup], batch(token(SOCIAL, 0)))).toBe('no-covering-key')
    expect(chosen([highGroup], batch(doc(SOCIAL, 'post')))).toBe(5)
  })

  it('never covers tokens with a document-type key, or a token outside the group', () => {
    const socialPostKey = key(7, { bounds: { kind: 'documentType', contractId: SOCIAL, documentTypeName: 'post' }, securityLevel: KeySecurityLevel.CRITICAL })
    expect(chosen([socialPostKey], batch(token(SOCIAL, 0)))).toBe('no-covering-key')
    expect(chosen(ring, batch(token(BLOG, 0)))).toBe('no-covering-key')
    expect(chosen(ring, batch(token(SHOP, 0)))).toBe(5)
    expect(chosen(ring, batch(token(SHOP, 1)))).toBe('no-covering-key')
    expect(chosen(ring, batch(doc(SHOP, 'order')))).toBe('no-covering-key')
  })

  it('honours a document type that requires CRITICAL', () => {
    const request = { ...batch(doc(DASHPAY, 'profile')), requiredSecurityLevel: KeySecurityLevel.CRITICAL }
    expect(chosen(ring, request)).toBe('no-covering-key')
  })

  it('drops expiring, spent, under-budget and disabled keys', () => {
    const post = batch(doc(SOCIAL, 'post'))
    expect(chosen([{ ...groupKey, expiresAt: NOW + 4 * 60_000 }], post)).toBe('no-covering-key')
    expect(chosen([{ ...groupKey, remainingBudget: 0n }], post)).toBe('no-covering-key')
    expect(chosen([{ ...groupKey, remainingBudget: 100n }], { ...post, estimatedCost: 101n })).toBe('no-covering-key')
    expect(chosen([{ ...groupKey, remainingBudget: 101n }], { ...post, estimatedCost: 101n })).toBe(5)
    expect(chosen([{ ...groupKey, disabled: true }], post)).toBe('no-covering-key')
  })

  it('prefers the narrowest key, then the least privileged', () => {
    const socialKey = key(8, { bounds: { kind: 'singleContract', contractId: SOCIAL } })
    const postKey = key(10, { bounds: { kind: 'documentType', contractId: SOCIAL, documentTypeName: 'post' } })
    const unbound = key(1, {})
    expect(chosen([unbound, groupKey, socialKey, postKey], batch(doc(SOCIAL, 'post')))).toBe(10)
    expect(chosen([unbound, groupKey, socialKey], batch(doc(SOCIAL, 'post')))).toBe(8)
    expect(chosen([unbound, groupKey], batch(doc(SOCIAL, 'post')))).toBe(5)
    const highGroup = { ...groupKey, keyId: 11, securityLevel: KeySecurityLevel.HIGH }
    expect(chosen([groupKey, highGroup], batch(doc(SOCIAL, 'post')))).toBe(11)
    expect(chosen([groupKey, highGroup], batch(token(SOCIAL, 0)))).toBe(5)
  })

  it('splits a mixed batch by key, and refuses one that cannot be covered', () => {
    const result = selectSigningKey(ring, batch(doc(DASHPAY, 'profile'), doc(SOCIAL, 'yapprProfile'), doc(SOCIAL, 'post')), { now: NOW, groups })
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'needs-split') throw new Error('expected a split plan')
    expect(result.plan.map((step) => [step.key.keyId, step.members.length])).toEqual([[6, 1], [5, 2]])
    expect(chosen(ring, batch(doc(DASHPAY, 'profile'), doc(KEY_EXCHANGE, 'loginKey')))).toBe('no-covering-key')
  })

  it('refuses an empty batch', () => {
    expect(chosen(ring, batch())).toBe('empty')
  })
})

describe('buildAppConnectSession', () => {
  it('keeps key metadata and stores private keys by reference', () => {
    const grant: AppConnectGrant = {
      identityId: 'Owner',
      authKeys: [{
        role: 'contractGroup',
        bindingIndex: 0,
        privateKey: new Uint8Array(32).fill(1),
        remainingBudget: 10n,
        key: {
          id: 5,
          type: KeyType.ECDSA_HASH160,
          purpose: KeyPurpose.AUTHENTICATION,
          securityLevel: KeySecurityLevel.CRITICAL,
          data: new Uint8Array(20),
          bounds: { kind: 'contractGroup', groupId: GROUP },
          totalBudget: 20n,
          expiresAt: NOW,
        },
      }],
      encryptionKeys: [{
        role: 'encryption',
        bindingIndex: 0,
        privateKey: new Uint8Array(32).fill(2),
        key: {
          id: 7,
          type: KeyType.ECDSA_SECP256K1,
          purpose: KeyPurpose.ENCRYPTION,
          securityLevel: KeySecurityLevel.MEDIUM,
          data: new Uint8Array(33),
          bounds: { kind: 'singleContract', contractId: 'Anchor' },
        },
      }],
    }
    const stored: Array<[number, number]> = []
    const session = buildAppConnectSession(grant, {
      network: 'devnet',
      appId: 'Anchor',
      groupId: GROUP,
      connectionId: '00'.repeat(16),
      grantedAt: NOW,
      keyRef: (privateKey, keyId) => {
        stored.push([keyId, privateKey[0]])
        return `k${keyId}`
      },
    })
    expect(stored).toEqual([[5, 1], [7, 2]])
    expect(session.authKeys).toEqual([{
      keyId: 5,
      bounds: { kind: 'contractGroup', groupId: GROUP },
      securityLevel: KeySecurityLevel.CRITICAL,
      totalBudget: 20n,
      remainingBudget: 10n,
      expiresAt: NOW,
      keyRef: 'k5',
    }])
    expect(session.encKey).toEqual({ keyId: 7, contractId: 'Anchor', keyRef: 'k7' })
    expect(JSON.stringify(session, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('privateKey')
  })
})
