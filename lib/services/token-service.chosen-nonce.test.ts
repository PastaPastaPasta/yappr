import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchTransition, Document, type DocumentObject, IdentityPublicKey, PlatformVersion, PrivateKey, StateTransition, VerifiedTokenActionWithDocument, ensureInitialized } from '@dashevo/evo-sdk'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { identityContractNonceConsumed } from '@/lib/document-id'
import { buildUnsignedDirectPurchaseTransition } from './token-purchase-builder'
import { buildUnsignedYappTipTransition } from './token-transfer-builder'
import { tipService } from './tip-service'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { tokenService } from './token-service'
import { buildWalletPurchase, buildWalletTip, prepareWalletPayment } from './wallet-payment-service'
import { tipHistoryService, TIP_PAGE_LIMIT, type ProvedTip } from './tip-history-service'
import { WALLET_TOKEN_SCOPE, loadReservation, reserveNonce, settlePendingWrites, withSdkSignedWrite } from './identity-nonce'

const OWNER = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR'
const OTHER = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8'
let currentIdentity: string | null = OWNER
let wif: string
let identityKey: IdentityPublicKey
const broadcast = vi.fn()
const sdk = {
  identities: {
    contractNonce: vi.fn(async () => BigInt(100)),
    fetch: async () => ({ publicKeys: [identityKey] }),
  },
  contracts: { fetch: vi.fn(), addKnown: vi.fn(async () => true) },
  tokens: { calculateId: async () => OTHER, claim: vi.fn(), transfer: vi.fn(), directPurchase: vi.fn() },
  stateTransitions: { broadcastAndWait: broadcast, broadcastAndWaitForAffectedState: broadcast },
}

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: () => ({ signer: {}, identityKey }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKeyRecord: () => ({ wif, fromPasskey: false }) }))
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
  reserveNonce(OWNER, YAPPR_CONTRACT_ID, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
})
afterEach(() => {
  unbind()
  vi.restoreAllMocks()
})

describe.each(['sign-out', 'account switch'])('token cancellation during chosen-nonce preparation: %s', (ending) => {
  it.each(['claim', 'purchase', 'transfer'] as const)('returns CANCELLED for %s, signs and broadcasts nothing, and restores the reservation', async (action) => {
    const before = loadReservation(OWNER, YAPPR_CONTRACT_ID)
    const sign = vi.spyOn(StateTransition.prototype, 'sign')
    sdk.contracts.fetch.mockImplementationOnce(async () => {
      // Preparation starts after the caller has set its sent flag and reserved 102.
      expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(102))
      currentIdentity = ending === 'sign-out' ? null : OTHER
      return {}
    })
    const result = action === 'claim' ? await tokenService.claimStarterGrant(OWNER)
      : action === 'purchase' ? await tokenService.buyYapp(OWNER, BigInt(100), BigInt(1))
      : await tokenService.transfer(OWNER, OTHER, BigInt(1))
    expect(result).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(sdk.contracts.fetch).toHaveBeenCalledOnce()
    expect(sign).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(sdk.tokens.claim).not.toHaveBeenCalled()
    expect(sdk.tokens.directPurchase).not.toHaveBeenCalled()
    expect(sdk.tokens.transfer).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toEqual(before)
  })
})


describe.each(['tip', 'purchase'] as const)('wallet %s signing fallback', action => {
  let reportedNonce: bigint
  let tip: bigint
  let payments: number
  let spent: Set<bigint>
  let localBytes: Uint8Array
  let balance: bigint
  let sentTips: ProvedTip[]

  function execute(nonce: bigint | undefined, payment: boolean): boolean {
    if (nonce === undefined) throw new Error('The transition carries no identity contract nonce')
    if (nonce > tip + BigInt(24) || identityContractNonceConsumed(chainNonce(), nonce)) return false
    spent.add(nonce)
    if (nonce > tip) tip = nonce
    if (payment) payments++
    return true
  }

  function chainNonce(): bigint {
    let raw = tip
    for (let behind = BigInt(1); behind <= BigInt(24); behind++) {
      const nonce = tip - behind
      if (nonce > BigInt(100) && !spent.has(nonce)) raw |= BigInt(1) << (BigInt(40) + behind - BigInt(1))
    }
    return raw
  }

  const buildPayment = () => action === 'tip'
    ? buildUnsignedYappTipTransition(OWNER, OTHER, BigInt(100), 'same payment')
    : buildUnsignedDirectPurchaseTransition(OWNER, BigInt(100), BigInt(1000))

  const sendPayment = (request: Awaited<ReturnType<typeof buildPayment>>) => action === 'tip'
    ? tipService.sendYappTipLocal(OWNER, OTHER, BigInt(100), undefined, 'same payment', request)
    : tokenService.buyYapp(OWNER, BigInt(100), BigInt(1000), request)

  beforeEach(() => {
    storage.clear()
    reportedNonce = BigInt(100)
    tip = BigInt(100)
    spent = new Set([BigInt(100)])
    payments = 0
    balance = BigInt(500)
    sentTips = []
    vi.spyOn(tokenService, 'getBalance').mockImplementation(async () => balance)
    vi.spyOn(tipHistoryService, 'getTipsSent').mockImplementation(async () => sentTips)
    sdk.identities.contractNonce.mockImplementation(async () => reportedNonce)
    sdk.contracts.fetch.mockResolvedValue({})
    broadcast.mockImplementation(async (transition: StateTransition) => {
      localBytes = transition.toBytes()
      expect(execute(transition.identityContractNonce, true)).toBe(true)
      const document = Document.fromObject({
        $formatVersion: '0', $id: new Uint8Array(32).fill(3), $ownerId: new Uint8Array(32).fill(2),
        $dataContractId: new Uint8Array(32).fill(1), $type: 'transfer', $revision: BigInt(1),
      } as unknown as DocumentObject, PlatformVersion.current())
      return VerifiedTokenActionWithDocument.fromObject({ document: document.toObject() })
    })
  })

  afterEach(() => { vi.useRealTimers() })

  const buildCachedPayment = () => action === 'tip'
    ? buildWalletTip(OWNER, OTHER, BigInt(100), undefined, 'same payment')
    : buildWalletPurchase(OWNER, BigInt(100), BigInt(1000))

  function recordPayment() {
    balance += BigInt(100)
    sentTips.push({ id: 'tip', from: OWNER, to: OTHER, amount: BigInt(100), createdAt: new Date() })
  }

  it('confirms a payment landing after the polling timeout and before Check again', async () => {
    vi.useFakeTimers()
    const cached = await buildCachedPayment()
    expect(await cached.checkOutcome()).toBe('absent')
    await vi.advanceTimersByTimeAsync(300_001)
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(payments).toBe(1)
  })

  it.each(['wallet retry then local fallback', 'local fallback'] as const)('replaces an expired absent payment for %s, sharing the new nonce', async path => {
    const cached = await buildCachedPayment()
    for (let nonce = BigInt(102); nonce <= BigInt(126); nonce++) expect(execute(nonce, false)).toBe(true)
    reportedNonce = chainNonce()
    expect(identityContractNonceConsumed(reportedNonce, BigInt(101))).toBe(true)
    const buildFresh = vi.fn(buildCachedPayment)
    const prepared = await prepareWalletPayment(cached, buildFresh)
    expect(prepared.completed).toBe(false)
    if (prepared.completed) throw new Error('Absent payment was reported completed')
    const replacement = prepared.payment
    expect(replacement).not.toBe(cached)
    expect(buildFresh).toHaveBeenCalledOnce()
    if (path === 'wallet retry then local fallback') {
      const local = await prepareWalletPayment(replacement, buildFresh)
      expect(local).toEqual({ completed: false, payment: replacement })
      expect(buildFresh).toHaveBeenCalledOnce()
    }
    expect(await sendPayment(replacement.request)).toEqual({ success: true })
    const wallet = StateTransition.fromBytes(replacement.request.bytes)
    try {
      expect(wallet.identityContractNonce).toBe(BigInt(127))
      expect(execute(wallet.identityContractNonce, true)).toBe(false)
      expect(execute(BigInt(101), true)).toBe(false)
    } finally { wallet.free() }
    expect(payments).toBe(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(127))
  })

  it('reuses an executable cached request for wallet retry and local fallback without a new nonce', async () => {
    const cached = await buildCachedPayment()
    expect(execute(BigInt(102), false)).toBe(true)
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(await sendPayment(cached.request)).toEqual({ success: true })
    expect(payments).toBe(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it('keeps the original request when the liveness read fails', async () => {
    const cached = await buildCachedPayment()
    sdk.identities.contractNonce.mockRejectedValueOnce(new Error('proof unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it('keeps an expired request when the payment outcome read fails', async () => {
    const cached = await buildCachedPayment()
    reportedNonce = BigInt(126)
    if (action === 'purchase') vi.mocked(tokenService.getBalance).mockRejectedValueOnce(new Error('balance unavailable'))
    else vi.mocked(tipHistoryService.getTipsSent).mockRejectedValueOnce(new Error('history unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('reads the outcome after liveness so a payment landing during that read cannot be replaced', async () => {
    const cached = await buildCachedPayment()
    sdk.identities.contractNonce.mockImplementationOnce(async () => {
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      reportedNonce = chainNonce()
      return reportedNonce
    })
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  if (action === 'purchase') {
    it('retains the purchase low-water baseline across retries', async () => {
      const cached = await buildCachedPayment()
      balance = BigInt(450)
      expect(await cached.checkOutcome()).toBe('absent')
      balance = BigInt(550)
      expect(await prepareWalletPayment(cached, buildCachedPayment)).toEqual({ completed: true })
    })
  } else {
    it('keeps an expired request when the history page cannot prove absence', async () => {
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      sentTips = Array.from({ length: TIP_PAGE_LIMIT }, (_, index) => ({
        id: `other-${index}`, from: OWNER, to: OTHER, amount: BigInt(1), createdAt: new Date(),
      }))
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached })
      expect(buildFresh).not.toHaveBeenCalled()
    })
  }

  it('executes only one payment when local fallback is followed by a late wallet broadcast', async () => {
    const request = await buildPayment()
    expect(await sendPayment(request)).toEqual({ success: true })
    const wallet = StateTransition.fromBytes(request.bytes)
    const key = PrivateKey.fromWIF(wif)
    try {
      wallet.sign(key, identityKey)
      wallet.verifyPublicKey(identityKey)
      execute(wallet.identityContractNonce, true)
      expect(payments).toBe(1)
      // An affected-state response alone cannot retire a scanned request.
      expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending.map(p => p.nonce)).toEqual([BigInt(101)])
      const local = StateTransition.fromBytes(localBytes)
      try {
        local.verifyPublicKey(identityKey)
        expect(local.identityContractNonce).toBe(wallet.identityContractNonce)
        expect(BatchTransition.fromStateTransition(local).toObject().transitions)
          .toEqual(BatchTransition.fromStateTransition(wallet).toObject().transitions)
      } finally { local.free() }
    } finally { key.free(); wallet.free() }
    reportedNonce = chainNonce()
    expect(await settlePendingWrites(OWNER, YAPPR_CONTRACT_ID)).toBe(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
  })

  it('allows an unrelated write immediately while the fallback nonce read is stale', async () => {
    vi.useFakeTimers()
    const request = await buildPayment()
    expect(await sendPayment(request)).toEqual({ success: true })
    const sdkWrite = vi.fn(async () => 'sdk')
    const chosen = vi.fn(async (nonce: bigint) => {
      expect(execute(nonce, false)).toBe(true)
      reportedNonce = chainNonce()
      return 'unrelated write'
    })
    const started = Date.now()
    const outcome = withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.runAllTimersAsync()
    expect(await outcome).toEqual({ value: 'unrelated write' })
    expect(Date.now()).toBe(started)
    expect(chosen).toHaveBeenCalledWith(BigInt(102))
    expect(sdkWrite).not.toHaveBeenCalled()
    expect(payments).toBe(1)
  })

  it('retains the wallet reservation on a local signing failure or consensus refusal', async () => {
    const request = await buildPayment()
    sdk.contracts.fetch.mockRejectedValueOnce(new Error('contract unavailable'))
    expect((await sendPayment(request)).success).toBe(false)
    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRejectedValueOnce(new Error('state transition broadcast error: insufficient balance (code=40500)'))
    expect((await sendPayment(request)).success).toBe(false)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toMatchObject([{ nonce: BigInt(101), scope: WALLET_TOKEN_SCOPE, expiresAt: null }])
    expect(identityContractNonceConsumed(reportedNonce, BigInt(101))).toBe(false)
  })

  it('cannot allocate a replacement when the wallet already consumed the nonce', async () => {
    const request = await buildPayment()
    expect(execute(BigInt(101), true)).toBe(true)
    reportedNonce = chainNonce()
    await settlePendingWrites(OWNER, YAPPR_CONTRACT_ID)
    broadcast.mockImplementationOnce(async (transition: StateTransition) => {
      expect(transition.identityContractNonce).toBe(BigInt(101))
      expect(execute(transition.identityContractNonce, true)).toBe(false)
      throw new Error('Identity contract nonce already present (code=1003)')
    })
    expect((await sendPayment(request)).success).toBe(false)
    expect(payments).toBe(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it.each(['sign-out', 'account switch'])('returns CANCELLED and retains the request on %s during local preparation', async ending => {
    const request = await buildPayment()
    const before = loadReservation(OWNER, YAPPR_CONTRACT_ID)
    const sign = vi.spyOn(StateTransition.prototype, 'sign')
    sdk.contracts.fetch.mockImplementationOnce(async () => {
      currentIdentity = ending === 'sign-out' ? null : OTHER
      return {}
    })
    expect(await sendPayment(request)).toMatchObject({ success: false, errorCode: 'CANCELLED' })
    expect(sign).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toEqual(before)
  })
})
