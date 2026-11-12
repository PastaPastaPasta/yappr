import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchTransition, Document, type DocumentObject, IdentityPublicKey, PlatformVersion, PrivateKey, StateTransition, TokenTransition, VerifiedTokenActionWithDocument, ensureInitialized } from '@dashevo/evo-sdk'
import { TOKEN_HISTORY_CONTRACT_ID, YAPPR_CONTRACT_ID } from '@/lib/constants'
import { CriticalKeyCancelledError } from '@/lib/auth/critical-key'
import { scopedKey } from '@/lib/storage-scope'
import { identityContractNonceConsumed } from '@/lib/document-id'
import { buildUnsignedDirectPurchaseTransition } from './token-purchase-builder'
import { buildUnsignedYappTipTransition } from './token-transfer-builder'
import { tipService } from './tip-service'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { tokenService } from './token-service'
import { buildWalletPurchase, buildWalletTip, clearPersistedWalletPayment, prepareLocalWalletPayment, prepareWalletPayment, type WalletPayment } from './wallet-payment-service'
import { tipHistoryService, TIP_PAGE_LIMIT, type ProvedTip } from './tip-history-service'
import { WALLET_TOKEN_SCOPE, ChosenWriteNotSentError, loadReservation, releaseNonce, reserveNonce, settlePendingWrites, withSdkSignedWrite } from './identity-nonce'

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
    contractNonceWithProof: vi.fn(),
    fetch: async () => ({ publicKeys: [identityKey] }),
  },
  documents: { getWithProof: vi.fn() },
  contracts: { fetch: vi.fn(), addKnown: vi.fn(async () => true) },
  tokens: { calculateId: async () => OTHER, claim: vi.fn(), transfer: vi.fn(), directPurchase: vi.fn() },
  stateTransitions: { broadcastAndWait: broadcast, broadcastAndWaitForAffectedState: broadcast },
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
  readPrivateKey.mockReturnValue({ wif, fromPasskey: false })
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
  let nonceHeight: bigint | undefined
  let historyHeight: bigint | undefined
  let receipts: Map<string, Document>
  let lastRequest: WalletPayment | undefined

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

  const sendPayment = (request?: Awaited<ReturnType<typeof buildPayment>>) => action === 'tip'
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
    nonceHeight = BigInt(200)
    historyHeight = BigInt(200)
    receipts = new Map()
    lastRequest = undefined
    sdk.documents.getWithProof.mockImplementation(async (contractId: string, type: string, id: string) => {
      expect(contractId).toBe(TOKEN_HISTORY_CONTRACT_ID)
      expect(type).toBe(action === 'tip' ? 'transfer' : 'directPurchase')
      return { data: receipts.get(id), metadata: { height: historyHeight }, proof: {} }
    })
    vi.spyOn(tokenService, 'getBalance').mockImplementation(async () => balance)
    vi.spyOn(tipHistoryService, 'getTipsSentWithProof').mockImplementation(async () => ({ tips: sentTips, height: historyHeight }))
    sdk.identities.contractNonce.mockImplementation(async () => reportedNonce)
    sdk.identities.contractNonceWithProof.mockImplementation(async () => ({
      data: reportedNonce, metadata: { height: nonceHeight }, proof: {},
    }))
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

  const buildCachedPayment = async (lockHeld = false) => {
    lastRequest = await (action === 'tip'
      ? buildWalletTip(OWNER, OTHER, BigInt(100), undefined, 'same payment', lockHeld)
      : buildWalletPurchase(OWNER, BigInt(100), BigInt(1000), lockHeld))
    return lastRequest
  }

  function receiptId(bytes: Uint8Array): string {
    const transition = StateTransition.fromBytes(bytes)
    const batch = BatchTransition.fromStateTransition(transition)
    const batched = batch.transitions
    const token = batched[0].toTransition()
    if (!(token instanceof TokenTransition)) throw new Error('Not a token transition')
    const id = token.getHistoricalDocumentId(OWNER)
    try { return id.toBase58() }
    finally { id.free(); token.free(); batched.forEach(item => item.free()); batch.free(); transition.free() }
  }

  function recordReceipt(payment: WalletPayment, fields: Record<string, unknown> = {}) {
    const data = payment.data
    const properties = data.kind === 'tip'
      ? { amount: BigInt(data.amount), toIdentityId: bs58.decode(data.recipientId), ...(data.note === undefined ? {} : { publicNote: data.note }) }
      : { tokenAmount: BigInt(data.amount), purchaseCost: BigInt(data.cost) }
    const id = receiptId(payment.request.bytes)
    receipts.set(id, Document.fromObject({
      $formatVersion: '0', $id: bs58.decode(id), $ownerId: bs58.decode(OWNER),
      $dataContractId: bs58.decode(TOKEN_HISTORY_CONTRACT_ID), $type: data.kind === 'tip' ? 'transfer' : 'directPurchase',
      tokenId: bs58.decode(OTHER), ...properties, ...fields,
    } as unknown as DocumentObject, PlatformVersion.current()))
  }

  function recordPayment() {
    if (lastRequest) recordReceipt(lastRequest)
    balance += BigInt(100)
    sentTips.push({ id: 'tip', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: 'same payment', createdAt: new Date() })
  }

  const context = { ownerId: OWNER, key: action, expose: () => {} }
  const storedPayments = () => JSON.parse(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.walletPayments?.[scopedKey('wallet-payments:v1')] ?? '[]') as { reservationId: string; nonce: string }[]

  const differentReceipts: [string, Record<string, unknown>][] = action === 'tip'
    ? [
        ['recipient', { toIdentityId: bs58.decode(OWNER) }],
        ['amount', { amount: BigInt(99) }],
        ['note', { publicNote: 'another payment' }],
        ['missing note', { publicNote: undefined }],
        ['token', { tokenId: bs58.decode(OWNER) }],
      ]
    : [
        ['amount', { tokenAmount: BigInt(99) }],
        ['token', { tokenId: bs58.decode(OWNER) }],
      ]

  it.each(differentReceipts)('rejects a receipt with a different %s at the consumed reserved nonce', async (field, fields) => {
    const payment = await buildCachedPayment()
    recordReceipt(payment, fields)
    expect(execute(payment.request.nonce, true)).toBe(true)
    reportedNonce = chainNonce()
    expect(await payment.checkOutcome(), field).toBe('absent')
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(payment, buildFresh)).toMatchObject({ completed: false })
    expect(buildFresh).toHaveBeenCalledOnce()
  })

  it('confirms the exact matching receipt payload at the consumed nonce', async () => {
    const payment = await buildCachedPayment()
    recordReceipt(payment)
    expect(execute(payment.request.nonce, true)).toBe(true)
    reportedNonce = chainNonce()
    expect(await payment.checkOutcome()).toBe('completed')
  })

  if (action === 'tip') {
    it('matches a transfer with no public note', async () => {
      const payment = await buildWalletTip(OWNER, OTHER, BigInt(100))
      recordReceipt(payment)
      reportedNonce = BigInt(101)
      expect(await payment.checkOutcome()).toBe('completed')
    })
  } else {
    it('matches the purchased token amount when the actual charge is below the agreed ceiling', async () => {
      const payment = await buildCachedPayment()
      recordReceipt(payment, { purchaseCost: BigInt(900) })
      reportedNonce = BigInt(101)
      expect(await payment.checkOutcome()).toBe('completed')
    })
  }

  it.each(['completed', 'absent'] as const)('continues the current operation after tab A clears a foreign cached blocker that is %s', async outcome => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    const buildOther = vi.fn((lockHeld = false) => action === 'tip'
      ? buildWalletPurchase(OWNER, BigInt(100), BigInt(1000), lockHeld)
      : buildWalletTip(OWNER, OTHER, BigInt(100), undefined, 'different payment', lockHeld))
    const otherContext = { ...context, key: 'different payment' }
    const blocked = await prepareWalletPayment(undefined, buildOther, otherContext)
    if (blocked.completed) throw new Error('Foreign payment was reported completed')
    expect(blocked).toMatchObject({ unresolved: true, different: true, payment: { key: context.key, kind: action } })
    expect(buildOther).not.toHaveBeenCalled()
    if (outcome === 'completed') {
      recordReceipt(first.payment)
      expect(execute(first.payment.request.nonce, true)).toBe(true)
      reportedNonce = chainNonce()
    } else reportedNonce = BigInt(126)
    await clearPersistedWalletPayment(OWNER, first.payment.request.reservationId)
    expect(storedPayments()).toEqual([])
    expect(await prepareLocalWalletPayment(blocked.payment, otherContext)).toEqual({ completed: false })
    const next = await prepareWalletPayment(blocked.payment, buildOther, otherContext)
    expect(next).toMatchObject({ completed: false, payment: { key: otherContext.key, kind: action === 'tip' ? 'purchase' : 'tip' } })
    if (next.completed || next.unresolved) throw new Error('Current operation was not prepared')
    expect(next.payment.request.reservationId).not.toBe(first.payment.request.reservationId)
    expect(buildOther).toHaveBeenCalledOnce()
    expect(storedPayments()).toHaveLength(1)
    expect(payments).toBe(outcome === 'completed' ? 1 : 0)
  })

  it('keeps a foreign cached blocker tagged as different when its shared record disappears before confirmation', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    await clearPersistedWalletPayment(OWNER, first.payment.request.reservationId)
    const otherContext = { ...context, key: 'different payment' }
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(first.payment, buildFresh, otherContext)).toEqual({
      completed: false, payment: first.payment, unresolved: true, different: true,
    })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('restores nonce 101 after a fresh-module reload without building 102, including local fallback', async () => {
    const prepared = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (prepared.completed) throw new Error('No payment was built')
    const originalBytes = prepared.payment.request.bytes
    vi.resetModules()
    const fresh = await import('./wallet-payment-service')
    const freshTokens = await import('./token-service')
    const freshHistory = await import('./tip-history-service')
    vi.spyOn(freshTokens.tokenService, 'getBalance').mockImplementation(async () => balance)
    vi.spyOn(freshHistory.tipHistoryService, 'getTipsSentWithProof').mockImplementation(async () => ({ tips: sentTips, height: historyHeight }))
    const buildFresh = vi.fn(buildCachedPayment)
    const restored = await fresh.prepareWalletPayment(undefined, buildFresh, context)
    if (restored.completed || restored.unresolved) throw new Error('The original request was not restored')
    expect(buildFresh).not.toHaveBeenCalled()
    expect(restored.payment.request.bytes).toEqual(originalBytes)
    expect(restored.payment.request.nonce).toBe(BigInt(101))
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    expect(await sendPayment(restored.payment.request)).toEqual({ success: true })
    expect(execute(BigInt(101), true)).toBe(false)
    expect(payments).toBe(1)
  })

  it('blocks a different unresolved payment until the explicit another-payment action', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    const buildOther = vi.fn((lockHeld = false) => action === 'tip'
      ? buildWalletPurchase(OWNER, BigInt(100), BigInt(1000), lockHeld)
      : buildWalletTip(OWNER, OTHER, BigInt(100), undefined, 'different payment', lockHeld))
    const anotherContext = { ...context, key: 'different payment' }
    const blocked = await prepareWalletPayment(undefined, buildOther, anotherContext)
    expect(blocked).toMatchObject({ completed: false, unresolved: true, different: true })
    expect(buildOther).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    const allowed = await prepareWalletPayment(undefined, buildOther, { ...anotherContext, allowAnother: new Set([first.payment.request.reservationId]) })
    if (allowed.completed || allowed.unresolved) throw new Error('Explicit new payment was blocked')
    expect(allowed.payment.request.nonce).toBe(BigInt(102))
    expect(storedPayments()).toHaveLength(2)
    expect(storedPayments()[0].reservationId).toBe(first.payment.request.reservationId)
  })

  it('clears a completed persisted record even after unrelated writes pruned its pending nonce', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    await settlePendingWrites(OWNER, YAPPR_CONTRACT_ID)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toHaveLength(0)
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(storedPayments()).toEqual([])
  })

  it('serializes two tabs preparing the same payment under the reservation lock', async () => {
    const buildFresh = vi.fn(buildCachedPayment)
    const [first, second] = await Promise.all([
      prepareWalletPayment(undefined, buildFresh, context),
      prepareWalletPayment(undefined, buildFresh, context),
    ])
    if (first.completed || second.completed) throw new Error('No payment to compare')
    expect(first.payment.request.bytes).toEqual(second.payment.request.bytes)
    expect(buildFresh).toHaveBeenCalledOnce()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  if (action === 'tip') {
    it('does not call a clock-skewed landed tip absent', async () => {
      const chainTime = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(chainTime + 180_000)
      const cached = await buildCachedPayment()
      recordPayment()
      sentTips = [{ id: 'landed', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: 'same payment', createdAt: new Date(chainTime) }]
      reportedNonce = BigInt(126)
      expect(await cached.checkOutcome()).toBe('completed')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it('matches a literal-note profile tip even when history parses its note as a post target', async () => {
      const note = 'yappr:tip:v1:post:' + OTHER
      const payment = await buildWalletTip(OWNER, OTHER, BigInt(100), undefined, note)
      recordReceipt(payment)
      reportedNonce = BigInt(101)
      sentTips = [{ id: 'literal-note', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: note, postId: OTHER, targetKind: 'post', createdAt: new Date() }]
      expect(await payment.checkOutcome()).toBe('completed')
      expect(await prepareWalletPayment(payment, buildCachedPayment)).toEqual({ completed: true })
    })

    it('clears a proved-absent persisted record before building its replacement', async () => {
      const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
      if (first.completed) throw new Error('No original payment')
      reportedNonce = BigInt(126)
      const buildFresh = vi.fn(async (lockHeld = false) => {
        expect(storedPayments()).toEqual([])
        return buildCachedPayment(lockHeld)
      })
      const next = await prepareWalletPayment(undefined, buildFresh, context)
      if (next.completed || next.unresolved) throw new Error('Proved-absent payment was retained')
      expect(next.payment.request.nonce).toBe(BigInt(127))
      expect(storedPayments()).toEqual([{ ...storedPayments()[0], nonce: '127' }])
      expect(storedPayments()[0].reservationId).not.toBe(first.payment.request.reservationId)
    })

    it.each(['unreadable', 'incomplete'])('uses the exact receipt even when sender history is %s', async state => {
      if (state === 'unreadable') vi.mocked(tipHistoryService.getTipsSentWithProof).mockRejectedValueOnce(new Error('no baseline'))
      else sentTips = Array.from({ length: TIP_PAGE_LIMIT }, (_, index) => ({ id: String(index), from: OWNER, to: OTHER, amount: BigInt(1), createdAt: new Date() }))
      const cached = await buildCachedPayment()
      recordPayment()
      reportedNonce = BigInt(101)
      expect(await cached.checkOutcome()).toBe('completed')
      expect(tipHistoryService.getTipsSentWithProof).not.toHaveBeenCalled()
    })

    it('does not mistake an identical transfer from the baseline for a new tip', async () => {
      recordPayment()
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      expect(await cached.checkOutcome()).toBe('absent')
    })
  }

  it('confirms a payment landing after the polling timeout and before Check again', async () => {
    vi.useFakeTimers()
    const cached = await buildCachedPayment()
    expect(await cached.checkOutcome()).toBe('unknown')
    await vi.advanceTimersByTimeAsync(300_001)
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(payments).toBe(1)
  })

  if (action === 'tip') {
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
  }

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
    sdk.identities.contractNonceWithProof.mockRejectedValueOnce(new Error('proof unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached, unresolved: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it('keeps an expired request when the payment outcome read fails', async () => {
    const cached = await buildCachedPayment()
    reportedNonce = BigInt(126)
    sdk.documents.getWithProof.mockRejectedValueOnce(new Error('receipt unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached, unresolved: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('reads the outcome after liveness so a payment landing during that read cannot be replaced', async () => {
    const cached = await buildCachedPayment()
    sdk.identities.contractNonceWithProof.mockImplementationOnce(async () => {
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      reportedNonce = chainNonce()
      return { data: reportedNonce, metadata: { height: nonceHeight }, proof: {} }
    })
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  if (action === 'purchase') {
    it('confirms the exact purchase receipt even when spending masks its balance rise', async () => {
      const cached = await buildCachedPayment()
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      balance -= BigInt(100)
      reportedNonce = chainNonce()
      expect(balance).toBe(BigInt(500))
      expect(await cached.checkOutcome()).toBe('completed')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: true })
      expect(buildFresh).not.toHaveBeenCalled()
      expect(payments).toBe(1)
    })

    it('replaces a purchase only after proved receipt absence and nonce consumption', async () => {
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      const buildFresh = vi.fn(buildCachedPayment)
      const next = await prepareWalletPayment(cached, buildFresh)
      expect(next).toMatchObject({ completed: false })
      expect(buildFresh).toHaveBeenCalledOnce()
    })

    it('ignores unrelated balance changes across retries', async () => {
      const cached = await buildCachedPayment()
      balance = BigInt(450)
      expect(await cached.checkOutcome()).toBe('unknown')
      balance = BigInt(550)
      expect(await prepareWalletPayment(cached, buildCachedPayment)).toEqual({ completed: false, payment: cached })
    })
  } else {
    it('keeps a consumed request when the outcome proof is a block behind', async () => {
      const cached = await buildCachedPayment()
      expect(execute(BigInt(101), true)).toBe(true)
      reportedNonce = chainNonce()
      historyHeight = BigInt(199)
      expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached, unresolved: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it.each([BigInt(200), BigInt(201)])('rebuilds only when absence is proved at height %s, at or above consumption', async height => {
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      historyHeight = height
      expect(await cached.checkOutcome()).toBe('absent')
      const buildFresh = vi.fn(buildCachedPayment)
      const prepared = await prepareWalletPayment(cached, buildFresh)
      expect(prepared.completed).toBe(false)
      if (prepared.completed) throw new Error('Absent tip was reported completed')
      expect(prepared.payment).not.toBe(cached)
      expect(buildFresh).toHaveBeenCalledOnce()
    })

    it('keeps the request when the nonce is still free despite current empty history', async () => {
      const cached = await buildCachedPayment()
      expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it.each(['nonce proof', 'nonce height', 'outcome proof', 'outcome height'])('keeps a consumed request when %s is unavailable', async missing => {
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      if (missing === 'nonce proof') sdk.identities.contractNonceWithProof.mockResolvedValueOnce({ data: reportedNonce, metadata: { height: nonceHeight } })
      if (missing === 'nonce height') nonceHeight = undefined
      if (missing === 'outcome proof') sdk.documents.getWithProof.mockResolvedValue({ data: undefined, metadata: { height: historyHeight } })
      if (missing === 'outcome height') historyHeight = undefined
      if (missing.startsWith('outcome')) expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toEqual({ completed: false, payment: cached, unresolved: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it('proves exact receipt absence even when sender history is a full page', async () => {
      const cached = await buildCachedPayment()
      reportedNonce = BigInt(126)
      sentTips = Array.from({ length: TIP_PAGE_LIMIT }, (_, index) => ({
        id: `other-${index}`, from: OWNER, to: OTHER, amount: BigInt(1), createdAt: new Date(),
      }))
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh)).toMatchObject({ completed: false })
      expect(buildFresh).toHaveBeenCalledOnce()
    })
  }

  it('uses the SDK receipt id derived from the owner, token, type and big-endian reserved nonce', async () => {
    const cached = await buildCachedPayment()
    reportedNonce = BigInt(126)
    const nonce = Buffer.alloc(8)
    nonce.writeBigUInt64BE(cached.request.nonce)
    const inputs = Buffer.concat([
      bs58.decode(OTHER), bs58.decode(OWNER),
      Buffer.from(action === 'tip' ? 'history_transfer' : 'history_directPurchase'), nonce,
    ])
    const expected = bs58.encode(createHash('sha256').update(createHash('sha256').update(inputs).digest()).digest())
    expect(await cached.checkOutcome()).toBe('absent')
    expect(sdk.documents.getWithProof).toHaveBeenLastCalledWith(TOKEN_HISTORY_CONTRACT_ID, action === 'tip' ? 'transfer' : 'directPurchase', expected)
  })

  it('reconciles tab B cached 101 after tab A completes and clears storage without building 102', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    await clearPersistedWalletPayment(OWNER, first.payment.request.reservationId)
    expect(storedPayments()).toEqual([])
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(first.payment, buildFresh, context)).toEqual({ completed: true })
    expect(await prepareLocalWalletPayment(first.payment, context)).toEqual({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    expect(payments).toBe(1)
  })

  it('keeps a cached request missing from storage unresolved when its receipt is unknown', async () => {
    const cached = { ...await buildCachedPayment(), key: context.key }
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached, unresolved: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('does not complete a matching transfer or unrelated balance rise while the nonce is unconsumed', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    recordPayment()
    expect(await first.payment.checkOutcome()).toBe('unknown')
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(first.payment, buildFresh, context)).toMatchObject({ completed: false })
    expect(storedPayments()).toHaveLength(1)
    expect(buildFresh).not.toHaveBeenCalled()
    expect(sdk.documents.getWithProof).not.toHaveBeenCalled()
  })

  it('does not confuse a lagging baseline or an unrelated balance rise with this consumed payment', async () => {
    const cached = await buildCachedPayment()
    balance += BigInt(100)
    sentTips = [{ id: 'older-identical-tip', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: 'same payment', createdAt: new Date() }]
    reportedNonce = BigInt(126)
    expect(await cached.checkOutcome()).toBe('absent')
    expect(sdk.documents.getWithProof).toHaveBeenLastCalledWith(TOKEN_HISTORY_CONTRACT_ID, action === 'tip' ? 'transfer' : 'directPurchase', receiptId(cached.request.bytes))
  })

  it('a local-only key-sheet cancel never allocates or persists a wallet request', async () => {
    const local = await prepareLocalWalletPayment(undefined, context)
    if (local.completed) throw new Error('No local attempt')
    readPrivateKey.mockImplementationOnce(() => { throw new CriticalKeyCancelledError() })
    expect(await sendPayment(local.payment?.request)).toMatchObject({ success: false, errorCode: 'CANCELLED' })
    expect(storedPayments()).toEqual([])
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toBeNull()
    const different = await prepareWalletPayment(undefined, buildCachedPayment, { ...context, key: 'different' })
    if (different.completed || different.unresolved) throw new Error('Different payment was blocked')
    expect(different.payment.request.nonce).toBe(BigInt(101))
  })

  it.each(['cancel', 'chosen write not sent'] as const)('a local-only %s leaves no wallet record or reservation and does not block the next different payment', async failure => {
    // A retired earlier write forces the normal local path to choose its nonce.
    const earlier = reserveNonce(OWNER, YAPPR_CONTRACT_ID, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
    releaseNonce(OWNER, YAPPR_CONTRACT_ID, earlier)
    const local = await prepareLocalWalletPayment(undefined, context)
    expect(local).toEqual({ completed: false })
    if (local.completed) throw new Error('No local payment was attempted')
    sdk.contracts.fetch.mockRejectedValueOnce(failure === 'cancel' ? new CriticalKeyCancelledError() : new Error('contract unavailable'))
    const result = await sendPayment(local.payment?.request)
    expect(result.success).toBe(false)
    if (failure === 'cancel') expect(result.errorCode).toBe('CANCELLED')
    expect(storedPayments()).toEqual([])
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    expect(broadcast).not.toHaveBeenCalled()
    const different = await prepareWalletPayment(undefined, buildCachedPayment, { ...context, key: 'different' })
    expect(different).toMatchObject({ completed: false })
    if (different.completed || different.unresolved) throw new Error('Different payment was blocked')
  })

  it('releases a proved-unsent normal local chosen allocation', async () => {
    const earlier = reserveNonce(OWNER, YAPPR_CONTRACT_ID, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
    releaseNonce(OWNER, YAPPR_CONTRACT_ID, earlier)
    await expect(withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, async () => 'unused', undefined, undefined, async () => {
      throw new ChosenWriteNotSentError(new Error('not signed'))
    })).rejects.toThrow(ChosenWriteNotSentError)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
    expect(storedPayments()).toEqual([])
  })

  it('does not release an exposed request on a local cancel', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed) throw new Error('No original payment')
    const local = await prepareLocalWalletPayment(first.payment, context)
    if (local.completed || !local.payment) throw new Error('No local fallback')
    sdk.contracts.fetch.mockRejectedValueOnce(new CriticalKeyCancelledError())
    expect(await sendPayment(local.payment.request)).toMatchObject({ success: false, errorCode: 'CANCELLED' })
    expect(storedPayments()).toHaveLength(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toMatchObject([{ nonce: BigInt(101), scope: WALLET_TOKEN_SCOPE }])
  })

  it('discards an unexposed QR build if the user leaves before it is ready', async () => {
    const expose = vi.fn()
    await prepareWalletPayment(undefined, buildCachedPayment, { ...context, expose, isCurrent: () => false })
    expect(expose).not.toHaveBeenCalled()
    expect(storedPayments()).toEqual([])
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
  })

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
