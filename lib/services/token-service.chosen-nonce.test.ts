import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityPublicKey, PrivateKey, StateTransition, ensureInitialized } from '@dashevo/evo-sdk'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { PAYMENT_PENDING_ERROR } from '@/lib/error-utils'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { tokenService } from './token-service'
import { WALLET_TOKEN_SCOPE, loadReservation, reserveNonce } from './identity-nonce'

const OWNER = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR'
const OTHER = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8'
let currentIdentity: string | null = OWNER
let wif: string
let identityKey: IdentityPublicKey
const readPrivateKey = vi.hoisted(() => vi.fn())
const broadcast = vi.fn()
const sdk = {
  identities: {
    contractNonce: vi.fn(async () => BigInt(100)),
    fetch: async () => ({ publicKeys: [identityKey] }),
  },
  contracts: { fetch: vi.fn(), addKnown: vi.fn(async () => true) },
  tokens: { calculateId: async () => OTHER, claim: vi.fn(), transfer: vi.fn(), directPurchase: vi.fn() },
  stateTransitions: { broadcastAndWait: broadcast, broadcastAndWaitForAffectedState: broadcast },
  wasm: { refreshIdentityNonce: vi.fn(async () => {}) },
}

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: () => ({ signer: {}, identityKey }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKeyRecord: readPrivateKey }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: identityKey }) }))
vi.mock('@/lib/auth/signing-keys', () => ({
  SigningUnavailableError: class extends Error {},
  hasAppConnectSession: () => false,
  assertRawKeyCovers: async () => {},
  reportSigningFailure: vi.fn(),
  reportSigningSuccess: vi.fn(),
}))
vi.mock('../contract-topology', () => ({ starterGrantAmount: () => BigInt(100), yappIsLocked: () => false, yappIsTransferable: () => true }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
})
let unbind: () => void

beforeAll(async () => {
  await ensureInitialized()
  const privateKey = PrivateKey.fromHex('0101010101010101010101010101010101010101010101010101010101010101', 'testnet')
  wif = privateKey.toWIF()
  identityKey = new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'critical', keyType: 'ecdsa_secp256k1', data: privateKey.getPublicKey().toBytes() })
  privateKey.free()
})
beforeEach(() => {
  storage.clear()
  currentIdentity = OWNER
  unbind = bindCurrentIdentity(() => currentIdentity)
  vi.clearAllMocks()
  sdk.identities.contractNonce.mockResolvedValue(BigInt(100))
  readPrivateKey.mockReturnValue({ wif, fromPasskey: false })
  // A wallet payment QR shown at 101 and closed unpaid: a scanned wallet may still broadcast it.
  reserveNonce(OWNER, YAPPR_CONTRACT_ID, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
})
afterEach(() => {
  unbind()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(value => ({ value }), (error: unknown) => ({ error }))
  await vi.runAllTimersAsync()
  return outcome
}

describe.each(['sign-out', 'account switch'])('token cancellation during chosen-nonce preparation: %s', (ending) => {
  it('returns CANCELLED for a claim past an unpaid QR, signs and broadcasts nothing, and restores the reservation', async () => {
    const before = loadReservation(OWNER, YAPPR_CONTRACT_ID)
    const sign = vi.spyOn(StateTransition.prototype, 'sign')
    sdk.contracts.fetch.mockImplementationOnce(async () => {
      // The claim is not held behind the QR: it prepares on a nonce of its own, never the QR's 101.
      expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(102))
      currentIdentity = ending === 'sign-out' ? null : OTHER
      return {}
    })
    expect(await tokenService.claimStarterGrant(OWNER)).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(sdk.contracts.fetch).toHaveBeenCalledOnce()
    expect(sign).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(sdk.tokens.claim).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toEqual(before)
  })
})

describe.each(['tip', 'purchase'] as const)('a local %s behind an unpaid wallet QR', action => {
  const pay = (service = tokenService) => action === 'tip'
    ? service.transfer(OWNER, OTHER, BigInt(100), 'same payment')
    : service.buyYapp(OWNER, BigInt(100), BigInt(1000))
  const sdkWrite = () => (action === 'tip' ? sdk.tokens.transfer : sdk.tokens.directPurchase)

  it.each(['this tab', 'another tab'])('is held in %s and sends nothing, so the payment can only go out once', async tab => {
    vi.useFakeTimers()
    let service = tokenService
    let unbindOther = () => {}
    if (tab === 'another tab') {
      vi.resetModules()
      unbindOther = (await import('@/lib/auth/active-identity')).bindCurrentIdentity(() => currentIdentity)
      service = (await import('./token-service')).tokenService
    }
    try {
      expect(await settle(pay(service))).toEqual({ value: { success: false, error: PAYMENT_PENDING_ERROR, errorCode: 'NETWORK_ERROR' } })
    } finally { unbindOther() }
    expect(sdkWrite()).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending.map(p => p.nonce)).toEqual([BigInt(101)])
  })

  it('stays held while the QR can still execute 24 nonces later, and goes ahead once it falls out of the window', async () => {
    vi.useFakeTimers()
    // 24 later writes landed and 101 is still unused: the wallet can still broadcast it.
    sdk.identities.contractNonce.mockResolvedValue(BigInt(125) | (BigInt(1) << BigInt(40 + 23)))
    expect(await settle(pay())).toMatchObject({ value: { success: false, error: PAYMENT_PENDING_ERROR } })
    expect(sdkWrite()).not.toHaveBeenCalled()
    // One more: 101 can never execute now, so the payment is sent.
    sdk.identities.contractNonce.mockResolvedValue(BigInt(126))
    sdkWrite().mockResolvedValue(undefined)
    expect(await settle(pay())).toEqual({ value: { success: true } })
    expect(sdkWrite()).toHaveBeenCalledOnce()
  })
})
