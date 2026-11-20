import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { Document, IdentityPublicKey, PlatformVersion, PrivateKey, StateTransition, ensureInitialized, type DocumentObject } from '@dashevo/evo-sdk'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { WALLET_TOKEN_SCOPE, loadReservation, reserveNonce } from './identity-nonce'
import { stateTransitionService } from './state-transition-service'

const OWNER = bs58.encode(new Uint8Array(32).fill(2))
const CONTRACT = bs58.encode(new Uint8Array(32).fill(1))
const DOCUMENT_ID = bs58.encode(new Uint8Array(32).fill(3))
let currentIdentity: string | null = OWNER
let wif: string
let identityKey: IdentityPublicKey
const broadcast = vi.fn()
const sdk = {
  identities: { fetch: vi.fn(async () => ({ publicKeys: [identityKey] })), contractNonce: vi.fn(async () => BigInt(100)) },
  contracts: { fetch: vi.fn(), addKnown: vi.fn(async () => true) },
  documents: { replace: vi.fn(), delete: vi.fn() },
  stateTransitions: { broadcastAndWait: broadcast, broadcastAndWaitForAffectedState: broadcast },
  wasm: { refreshIdentityNonce: vi.fn(async () => {}) },
}

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: () => ({ signer: {}, identityKey }) } }))
vi.mock('@/lib/auth/signing-keys', () => ({
  resolveSigningKey: async () => ({ wif, identityKey }),
  reportSigningFailure: vi.fn(async () => {}),
  reportSigningSuccess: vi.fn(),
}))
vi.mock('./document-builder-service', () => ({
  documentBuilderService: {
    buildDocumentForReplace: async () => document(),
    buildDocumentForDelete: () => ({ id: DOCUMENT_ID, ownerId: OWNER, dataContractId: CONTRACT, documentTypeName: 'post' }),
    buildDocumentForValuesDelete: async () => document(),
  },
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
})

function document() {
  return Document.fromObject({
    $formatVersion: '0', $id: bs58.decode(DOCUMENT_ID), $ownerId: bs58.decode(OWNER),
    $dataContractId: bs58.decode(CONTRACT), $type: 'post', $revision: BigInt(2),
    $entropy: new Uint8Array(32).fill(7), content: 'kept content',
  } as unknown as DocumentObject, PlatformVersion.current())
}

let unbind: () => void
beforeAll(async () => {
  await ensureInitialized()
  const privateKey = PrivateKey.fromHex('0101010101010101010101010101010101010101010101010101010101010101', 'testnet')
  wif = privateKey.toWIF()
  identityKey = new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: privateKey.getPublicKey().toBytes() })
  privateKey.free()
})
beforeEach(() => {
  storage.clear()
  vi.clearAllMocks()
  currentIdentity = OWNER
  unbind = bindCurrentIdentity(() => currentIdentity)
  // A wallet payment QR closed unpaid: these writes take a chosen nonce past it.
  reserveNonce(OWNER, CONTRACT, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
})
afterEach(() => {
  unbind()
  vi.restoreAllMocks()
})

describe.each(['sign-out', 'account switch'])('a chosen-nonce document write cancelled during preparation: %s', ending => {
  it.each(['replace', 'delete', 'index-only delete'] as const)('signs and broadcasts nothing for a %s, and releases its nonce', async write => {
    const before = loadReservation(OWNER, CONTRACT)
    const sign = vi.spyOn(StateTransition.prototype, 'sign')
    sdk.contracts.fetch.mockImplementationOnce(async () => {
      expect(loadReservation(OWNER, CONTRACT)?.mark).toBe(BigInt(102))
      currentIdentity = ending === 'sign-out' ? null : bs58.encode(new Uint8Array(32).fill(9))
      return {}
    })
    const result = write === 'replace' ? await stateTransitionService.updateDocument(CONTRACT, 'post', DOCUMENT_ID, OWNER, { content: 'edited' }, 2)
      : write === 'delete' ? await stateTransitionService.deleteDocument(CONTRACT, 'post', DOCUMENT_ID, OWNER)
      : await stateTransitionService.deleteDocumentByValues(CONTRACT, 'post', OWNER, { documentId: DOCUMENT_ID, createdAtMs: 1, data: { content: 'kept content' } })
    expect(result.success).toBe(false)
    expect(sdk.contracts.fetch).toHaveBeenCalledOnce()
    expect(sign).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(sdk.documents.replace).not.toHaveBeenCalled()
    expect(sdk.documents.delete).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, CONTRACT)).toEqual(before)
  })
})
