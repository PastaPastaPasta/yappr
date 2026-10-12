import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'
import { hash160 } from '../key-exchange/yappr-protocol'
import { sealAppConnectPayload } from './crypto'
import type { AppConnectRequest } from './request'
import { DASHPAY_CONTRACT_ID, NINETY_DAYS_MS, VECTOR_CREATED_AT, seed, vectorKeys, yapprVectorRequest } from './test-helpers'
import { KeyPurpose, KeySecurityLevel, KeyType, type AppConnectIdentityKey, type AppConnectIdentityPort } from './types'
import { verifyAppConnectCandidate, type AppConnectVerification } from './verify'

const OWNER = bs58.encode(vectorKeys.ownerId)
const STRANGER_BYTES = seed('stranger')
const STRANGER = bs58.encode(STRANGER_BYTES)
const APP_ID = bs58.encode(vectorKeys.appId)
const GROUP_ID = bs58.encode(vectorKeys.groupId)
const EXPIRES_AT = VECTOR_CREATED_AT + NINETY_DAYS_MS
const NOW = VECTOR_CREATED_AT + 60_000

function pub(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

function groupKey(overrides: Partial<AppConnectIdentityKey> = {}): AppConnectIdentityKey {
  return {
    id: 5,
    type: KeyType.ECDSA_HASH160,
    purpose: KeyPurpose.AUTHENTICATION,
    securityLevel: KeySecurityLevel.CRITICAL,
    data: hash160(pub(vectorKeys.groupKey)),
    bounds: { kind: 'contractGroup', groupId: GROUP_ID },
    totalBudget: 50_000_000_000n,
    expiresAt: EXPIRES_AT,
    ...overrides,
  }
}

function profileKey(overrides: Partial<AppConnectIdentityKey> = {}): AppConnectIdentityKey {
  return {
    id: 6,
    type: KeyType.ECDSA_SECP256K1,
    purpose: KeyPurpose.AUTHENTICATION,
    securityLevel: KeySecurityLevel.HIGH,
    data: pub(vectorKeys.profileKey),
    bounds: { kind: 'documentType', contractId: DASHPAY_CONTRACT_ID, documentTypeName: 'profile' },
    totalBudget: 1_000_000_000n,
    expiresAt: EXPIRES_AT,
    ...overrides,
  }
}

function encryptionKey(overrides: Partial<AppConnectIdentityKey> = {}): AppConnectIdentityKey {
  return {
    id: 7,
    type: KeyType.ECDSA_SECP256K1,
    purpose: KeyPurpose.ENCRYPTION,
    securityLevel: KeySecurityLevel.MEDIUM,
    data: pub(vectorKeys.encryptionKey),
    bounds: { kind: 'singleContract', contractId: APP_ID },
    ...overrides,
  }
}

const masterKey: AppConnectIdentityKey = {
  id: 0,
  type: KeyType.ECDSA_SECP256K1,
  purpose: KeyPurpose.AUTHENTICATION,
  securityLevel: KeySecurityLevel.MASTER,
  data: pub(seed('master')),
}

interface Scenario {
  request?: AppConnectRequest
  slots?: Uint8Array[]
  /** Identity whose id the AAD carries. */
  sealedFor?: Uint8Array
  /** Identity the response is published under. */
  publishedAs?: string
  keys?: AppConnectIdentityKey[]
  identities?: Record<string, AppConnectIdentityKey[]>
  budgets?: Record<number, bigint | undefined>
  currentEncryptionKeys?: AppConnectIdentityKey[]
  now?: number
}

async function verify(scenario: Scenario = {}): Promise<AppConnectVerification> {
  const request = scenario.request ?? yapprVectorRequest()
  const keys = scenario.keys ?? [masterKey, groupKey(), profileKey(), encryptionKey()]
  const identities = scenario.identities ?? { [OWNER]: keys }
  const budgets = scenario.budgets ?? { 5: 49_000_000_000n, 6: 900_000_000n }
  const port: AppConnectIdentityPort = {
    getIdentityFresh: async (id) => (identities[id] ? { id, publicKeys: identities[id] } : null),
    remainingBudgets: async (_id, keyIds) => new Map(keyIds.map((keyId) => [keyId, budgets[keyId]])),
    contractKeys: async (id, contractId, purpose) =>
      id === OWNER && contractId === APP_ID && purpose === KeyPurpose.ENCRYPTION
        ? scenario.currentEncryptionKeys ?? [encryptionKey()]
        : [],
    groupInfo: async () => null,
  }
  const response = await sealAppConnectPayload({
    appEphemeralPubKey: request.appEphemeralPubKey,
    ownerId: scenario.sealedFor ?? vectorKeys.ownerId,
    slots: scenario.slots ?? [vectorKeys.groupKey, vectorKeys.profileKey, vectorKeys.encryptionKey],
  })
  return verifyAppConnectCandidate({
    request,
    appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
    candidate: { ownerId: scenario.publishedAs ?? OWNER, ...response },
    identity: port,
    now: scenario.now ?? NOW,
  })
}

function rejection(result: AppConnectVerification) {
  if (result.ok) throw new Error('expected a rejection')
  return { reason: result.reason, retryable: result.retryable, slot: result.slot }
}

describe('verifyAppConnectCandidate', () => {
  it('accepts the full Yappr grant and classifies each key', async () => {
    const result = await verify()
    if (!result.ok) throw new Error(`rejected: ${result.reason}`)
    const { grant } = result
    expect(grant.identityId).toBe(OWNER)
    expect(grant.authKeys.map((k) => [k.role, k.key.id, k.remainingBudget])).toEqual([
      ['contractGroup', 5, 49_000_000_000n],
      ['documentType', 6, 900_000_000n],
    ])
    expect(grant.encryptionKeys.map((k) => [k.role, k.key.id])).toEqual([['encryption', 7]])
    expect(grant.authKeys[0].privateKey).toEqual(vectorKeys.groupKey)
  })

  it('accepts a partial grant that keeps the primary binding, in any slot order', async () => {
    const result = await verify({ slots: [vectorKeys.encryptionKey, vectorKeys.groupKey] })
    expect(result.ok && result.grant.authKeys.map((k) => k.role)).toEqual(['contractGroup'])
  })

  it('accepts a HIGH group key when CRITICAL was asked (the claim is just unavailable)', async () => {
    const result = await verify({ keys: [groupKey({ securityLevel: KeySecurityLevel.HIGH }), profileKey(), encryptionKey()] })
    expect(result.ok).toBe(true)
  })

  it('matches both ECDSA_HASH160 and ECDSA_SECP256K1 key data', async () => {
    const swapped = [
      groupKey({ type: KeyType.ECDSA_SECP256K1, data: pub(vectorKeys.groupKey) }),
      profileKey({ type: KeyType.ECDSA_HASH160, data: hash160(pub(vectorKeys.profileKey)) }),
      encryptionKey(),
    ]
    expect((await verify({ keys: swapped })).ok).toBe(true)
  })

  it('honours the identity hint', async () => {
    const hinted = { ...yapprVectorRequest(), identityHint: vectorKeys.ownerId }
    expect((await verify({ request: hinted })).ok).toBe(true)
    const other = { ...yapprVectorRequest(), identityHint: STRANGER_BYTES }
    expect(rejection(await verify({ request: other })).reason).toBe('hint-mismatch')
  })

  const cases: Array<[string, Scenario, string, boolean?]> = [
    ['a response copied under another identity', { publishedAs: STRANGER, identities: { [STRANGER]: [groupKey()] } }, 'decrypt'],
    ['keys that live on another identity (wrong owner)', {
      sealedFor: STRANGER_BYTES,
      publishedAs: STRANGER,
      identities: { [OWNER]: [groupKey(), profileKey(), encryptionKey()], [STRANGER]: [masterKey] },
    }, 'key-not-found', true],
    ['an identity that cannot be read yet', { identities: {} }, 'identity-not-found', true],
    ['an unregistered key', { keys: [masterKey, profileKey(), encryptionKey()] }, 'key-not-found', true],
    ['a disabled key', { keys: [groupKey({ disabledAt: NOW - 1 }), profileKey(), encryptionKey()] }, 'key-disabled'],
    ['an unbound auth key', { keys: [groupKey({ bounds: undefined }), profileKey(), encryptionKey()] }, 'key-unbound'],
    ['a MASTER key', { keys: [groupKey({ securityLevel: KeySecurityLevel.MASTER }), profileKey(), encryptionKey()] }, 'key-master'],
    ['a CRITICAL key on the DashPay binding', { keys: [groupKey(), profileKey({ securityLevel: KeySecurityLevel.CRITICAL }), encryptionKey()] }, 'key-level'],
    ['a MEDIUM group key', { keys: [groupKey({ securityLevel: KeySecurityLevel.MEDIUM }), profileKey(), encryptionKey()] }, 'key-level'],
    ['a key bound to another group', { keys: [groupKey({ bounds: { kind: 'contractGroup', groupId: STRANGER } }), profileKey(), encryptionKey()] }, 'key-unmatched'],
    ['a key bound to another DashPay type', {
      keys: [groupKey(), profileKey({ bounds: { kind: 'documentType', contractId: DASHPAY_CONTRACT_ID, documentTypeName: 'contactRequest' } }), encryptionKey()],
    }, 'key-unmatched'],
    ['a key bound to a foreign contract', { keys: [groupKey({ bounds: { kind: 'singleContract', contractId: STRANGER } }), profileKey(), encryptionKey()] }, 'key-unmatched'],
    ['a TRANSFER key', { keys: [groupKey({ purpose: KeyPurpose.TRANSFER }), profileKey(), encryptionKey()] }, 'key-purpose'],
    ['a key that expires within the margin', { keys: [groupKey({ expiresAt: NOW + 30 * 60_000 }), profileKey(), encryptionKey()] }, 'key-expired'],
    ['an expired key', { keys: [groupKey({ expiresAt: NOW - 1 }), profileKey(), encryptionKey()] }, 'key-expired'],
    ['a group key without a budget', { keys: [groupKey({ totalBudget: undefined }), profileKey(), encryptionKey()] }, 'key-limits'],
    ['a key that dropped the requested budget', { keys: [groupKey(), profileKey({ totalBudget: undefined }), encryptionKey()] }, 'key-limits'],
    ['a key that dropped the requested expiry', { keys: [groupKey({ expiresAt: undefined }), profileKey(), encryptionKey()] }, 'key-limits'],
    ['a spent budget', { budgets: { 5: 0n, 6: 1n } }, 'budget-exhausted'],
    ['a budget Platform does not report (yet)', { budgets: { 6: 1n } }, 'budget-unknown', true],
    ['an encryption key that is not current', { currentEncryptionKeys: [encryptionKey({ id: 9, data: pub(seed('newer')) })] }, 'encryption-key-not-current', true],
    ['an encryption key at HIGH', { keys: [groupKey(), profileKey(), encryptionKey({ securityLevel: KeySecurityLevel.HIGH })] }, 'key-level'],
    ['a hash-only encryption key', {
      keys: [groupKey(), profileKey(), encryptionKey({ type: KeyType.ECDSA_HASH160, data: hash160(pub(vectorKeys.encryptionKey)) })],
    }, 'key-type'],
    ['an unbound encryption key', { keys: [groupKey(), profileKey(), encryptionKey({ bounds: undefined })] }, 'key-unbound'],
    ['an encryption key bound elsewhere', { keys: [groupKey(), profileKey(), encryptionKey({ bounds: { kind: 'singleContract', contractId: STRANGER } })] }, 'key-unmatched'],
    ['a grant without the primary binding', { slots: [vectorKeys.profileKey, vectorKeys.encryptionKey] }, 'primary-missing'],
    ['the same key twice', { slots: [vectorKeys.groupKey, vectorKeys.groupKey] }, 'duplicate-binding'],
    ['two keys for one binding', {
      slots: [vectorKeys.groupKey, seed('second group key')],
      keys: [groupKey(), groupKey({ id: 8, data: hash160(pub(seed('second group key'))) })],
    }, 'duplicate-binding'],
    ['more slots than bindings', { slots: [vectorKeys.groupKey, vectorKeys.profileKey, vectorKeys.encryptionKey, seed('extra')] }, 'framing'],
    ['a slot that is not a private key', { slots: [vectorKeys.groupKey, new Uint8Array(32)] }, 'invalid-key'],
  ]

  for (const [name, scenario, reason, retryable = false] of cases) {
    it(`rejects ${name}`, async () => {
      const result = rejection(await verify(scenario))
      expect(result.reason).toBe(reason)
      expect(result.retryable).toBe(retryable)
    })
  }

  it('reports which slot failed', async () => {
    const result = rejection(await verify({ keys: [groupKey(), profileKey({ disabledAt: 1 }), encryptionKey()] }))
    expect(result.slot).toBe(1)
  })

  it('rejects a CRITICAL group key when only HIGH was asked', async () => {
    const request = yapprVectorRequest()
    request.authBindings[0] = { ...request.authBindings[0], securityLevel: KeySecurityLevel.HIGH }
    expect(rejection(await verify({ request })).reason).toBe('key-level')
  })
})
