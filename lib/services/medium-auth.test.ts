import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import initWasm, { IdentityPublicKey, IdentityUpdateTransition, StateTransition, BatchTransition } from '@dashevo/wasm-sdk/compressed'
import bs58 from 'bs58'
import { getPublicKey } from '@noble/secp256k1'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { hash160 } from '@/lib/crypto/hash'
import { keyValidationService } from './key-validation-service'
import { tokenService } from './token-service'
import { stateTransitionService } from './state-transition-service'
import { buildUnsignedKeyRegistrationTransition } from './identity-update-builder'

const mocks = vi.hoisted(() => ({ getSdk: vi.fn(), getPrivateKey: vi.fn(), getIdentity: vi.fn() }))
// Use one real WASM module for the facade's re-exports and the registration builder.
vi.mock('@dashevo/evo-sdk', () => import('@dashevo/wasm-sdk/compressed'))
vi.mock('./identity-service', () => ({ identityService: { getIdentity: mocks.getIdentity } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: mocks.getSdk }))
vi.mock('@/lib/secure-storage', () => ({ getPrivateKey: mocks.getPrivateKey }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/auth-utils', () => ({ promptForAuthKey: vi.fn() }))

const ownerId = bs58.encode(new Uint8Array(32).fill(1))
const contractId = bs58.encode(new Uint8Array(32).fill(2))
const documentId = bs58.encode(new Uint8Array(32).fill(3))
const authPrivateKey = new Uint8Array(32).fill(4)
const encryptionPrivateKey = new Uint8Array(32).fill(5)
let identityKey: IdentityPublicKey
const sdk = {
  tokens: { directPurchase: vi.fn() },
  identities: { fetch: vi.fn(), nonce: vi.fn().mockResolvedValue(1n) },
  documents: { get: vi.fn().mockResolvedValue(null), replace: vi.fn(), delete: vi.fn() },
  stateTransitions: {
    broadcastStateTransition: vi.fn(), waitForResponse: vi.fn(), waitForAffectedState: vi.fn(),
  },
  wasm: { getIdentityContractNonce: vi.fn().mockResolvedValue(1n), refreshIdentityNonce: vi.fn() },
}

beforeAll(async () => {
  await initWasm()
})

beforeEach(() => {
  vi.clearAllMocks()
  identityKey = new IdentityPublicKey({
    keyId: 5, purpose: 'authentication', securityLevel: 'medium',
    keyType: 'ecdsa_hash160', isReadOnly: false, data: hash160(getPublicKey(authPrivateKey)),
  })
  sdk.identities.fetch.mockResolvedValue({ publicKeys: [identityKey], toJSON: () => ({ revision: 2 }) })
  mocks.getSdk.mockResolvedValue(sdk)
  mocks.getPrivateKey.mockReturnValue(privateKeyToWif(authPrivateKey, 'testnet'))
  const values = new Map<string, string>()
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})

afterEach(() => {
  identityKey.free()
  vi.unstubAllGlobals()
})

describe('MEDIUM document signing with the real WASM SDK (network mocked)', () => {
  it.each([false, true])('signs a create, including a token fee: %s', async (withFee) => {
    const result = await stateTransitionService.createDocument(contractId, 'post', ownerId, { content: 'hello' }, {
      documentId,
      ...(withFee ? { tokenPayment: { maximumTokenCost: 10 } } : {}),
    })
    expect(result.success, result.error).toBe(true)
    const transition = sdk.stateTransitions.broadcastStateTransition.mock.calls[0][0] as StateTransition
    const batch = BatchTransition.fromStateTransition(StateTransition.fromBytes(transition.toBytes())).toJSON()
    if (withFee) {
      expect(batch.transitions[0]).toMatchObject({ $tokenPaymentInfo: { maximumTokenCost: 10 } })
    } else {
      expect(batch.transitions[0]).toMatchObject({ $tokenPaymentInfo: null })
    }
    expect(transition.signaturePublicKeyId).toBe(5)
    expect(transition.signature?.length).toBe(65)
    expect(() => transition.verifyPublicKey(identityKey)).not.toThrow()
  })

  it('passes the MEDIUM signer through replace, delete and index-only delete', async () => {
    const replace = await stateTransitionService.updateDocument(contractId, 'post', documentId, ownerId, { content: 'edited' }, 1)
    expect(replace.success, replace.error).toBe(true)
    const remove = await stateTransitionService.deleteDocument(contractId, 'post', documentId, ownerId)
    expect(remove.success, remove.error).toBe(true)
    const byValues = await stateTransitionService.deleteDocumentByValues(contractId, 'like', ownerId, {
      documentId, createdAtMs: 1700000000000, data: {},
    })
    expect(byValues.success, byValues.error).toBe(true)
    expect(sdk.documents.replace.mock.calls[0][0].identityKey.securityLevelNumber).toBe(3)
    expect(sdk.documents.delete.mock.calls).toHaveLength(2)
    for (const [options] of sdk.documents.delete.mock.calls) {
      expect(options.identityKey.securityLevelNumber).toBe(3)
    }
  })

  it('rejects a disabled MEDIUM key before broadcasting', async () => {
    identityKey.disabledAt = 1n
    const result = await stateTransitionService.createDocument(contractId, 'post', ownerId, { content: 'hello' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('No suitable signing key')
    expect(sdk.stateTransitions.broadcastStateTransition).not.toHaveBeenCalled()
  })
})

it('serializes a wallet registration that requests MEDIUM auth and encryption keys', async () => {
  const result = await buildUnsignedKeyRegistrationTransition({
    identityId: ownerId, authPrivateKey, authPublicKey: getPublicKey(authPrivateKey),
    encryptionPrivateKey, encryptionPublicKey: getPublicKey(encryptionPrivateKey),
  })
  const transition = IdentityUpdateTransition.fromBytes(result.transitionBytes)
  const keys = transition.toJSON().addPublicKeys ?? []
  expect(keys.map((key) => [key.purpose, key.securityLevel])).toEqual([[0, 3], [1, 3]])
  expect(keys[0]).toMatchObject({ id: 6 })
  expect(keys[0].signature).toBe('')
  expect(Buffer.from(keys[1].signature ?? '', 'base64').length).toBe(65)
  expect(transition.toStateTransition().purposeRequirement).toEqual(['AUTHENTICATION'])
  expect(transition.toStateTransition().getKeyLevelRequirement('authentication')).toEqual(['MASTER'])
})

it('logs in with the registered MEDIUM authentication key', async () => {
  mocks.getIdentity.mockResolvedValue({ publicKeys: [identityKey.toJSON()] })
  const result = await keyValidationService.validatePrivateKey(privateKeyToWif(authPrivateKey, 'testnet'), ownerId)
  expect(result).toMatchObject({ isValid: true, securityLevel: 3, purpose: 0 })
})

it('requests CRITICAL authorization for a token purchase with a MEDIUM login', async () => {
  const result = await tokenService.buyYapp(ownerId, 100n, 1000n)
  expect(result).toMatchObject({ success: false, errorCode: 'NEEDS_CRITICAL_KEY' })
  expect(sdk.tokens.directPurchase).not.toHaveBeenCalled()
})
