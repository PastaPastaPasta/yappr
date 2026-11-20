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
import { COMPLETION_RETENTION_MS, MAY_HAVE_PAID_MESSAGE, PAID_ELSEWHERE_MESSAGE, StalePaymentError, buildWalletPurchase, buildWalletTip, clearPersistedWalletPayment, prepareLocalWalletPayment, prepareWalletPayment, type LocalWalletPaymentIntent, type PayAgainConsent, type WalletPayment } from './wallet-payment-service'
import { tipHistoryService, TIP_PAGE_LIMIT, type ProvedTip } from './tip-history-service'
import { WALLET_TOKEN_SCOPE, ChosenWriteNotSentError, loadReservation, loadWalletPayments, releaseNonce, reserveNonce, settlePendingWrites, storeWalletPayments, withSdkSignedWrite } from './identity-nonce'

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

  const sendPayment = (request?: Awaited<ReturnType<typeof buildPayment>> | LocalWalletPaymentIntent) => action === 'tip'
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

  /** A confirmation of this payment, started when the test starts. */
  const context = { ownerId: OWNER, key: action, startedAt: 0, expose: () => {} }
  beforeEach(() => { context.startedAt = Date.now() })
  const unreadable: PayAgainConsent = { key: action, evidence: 'unreadable' }
  /** A QR shown for this payment: built and stored, as a confirmation does. */
  const shownPayment = async () => {
    const shown = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (shown.completed || shown.unproven) throw new Error('No QR payment')
    return shown.payment
  }
  const storedPayments = () => JSON.parse(loadWalletPayments(OWNER, YAPPR_CONTRACT_ID, scopedKey('wallet-payments:v1')) ?? '[]') as { key: string; reservationId: string; nonce: string }[]
  /** Another tab proved a stored request unpaid and dropped it. */
  const dropStored = (reservationId: string) => storeWalletPayments(OWNER, YAPPR_CONTRACT_ID, scopedKey('wallet-payments:v1'),
    JSON.stringify(storedPayments().filter(record => record.reservationId !== reservationId)))

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
        ['charge above the agreed ceiling', { purchaseCost: BigInt(1001) }],
        ['missing charge', { purchaseCost: undefined }],
        ['token', { tokenId: bs58.decode(OWNER) }],
      ]

  it.each(differentReceipts)('rejects a receipt with a different %s at the consumed reserved nonce', async (field, fields) => {
    const payment = await shownPayment()
    recordReceipt(payment, fields)
    expect(execute(payment.request.nonce, true)).toBe(true)
    reportedNonce = chainNonce()
    expect(await payment.checkOutcome(), field).toBe('absent')
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(payment, buildFresh, context)).toMatchObject({ completed: false, payment: { request: { nonce: BigInt(102) } } })
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

  it('restores nonce 101 after a fresh-module reload without building 102, including local fallback', async () => {
    const prepared = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (prepared.completed || prepared.unproven) throw new Error('No payment was built')
    const originalBytes = prepared.payment.request.bytes
    vi.resetModules()
    const fresh = await import('./wallet-payment-service')
    const freshTokens = await import('./token-service')
    const freshHistory = await import('./tip-history-service')
    vi.spyOn(freshTokens.tokenService, 'getBalance').mockImplementation(async () => balance)
    vi.spyOn(freshHistory.tipHistoryService, 'getTipsSentWithProof').mockImplementation(async () => ({ tips: sentTips, height: historyHeight }))
    const buildFresh = vi.fn(buildCachedPayment)
    const restored = await fresh.prepareWalletPayment(undefined, buildFresh, context)
    if (restored.completed || restored.unproven || restored.unresolved) throw new Error('The original request was not restored')
    expect(buildFresh).not.toHaveBeenCalled()
    expect(restored.payment.request.bytes).toEqual(originalBytes)
    expect(restored.payment.request.nonce).toBe(BigInt(101))
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    expect(await sendPayment(restored.payment.request)).toEqual({ success: true })
    expect(execute(BigInt(101), true)).toBe(false)
    expect(payments).toBe(1)
  })

  it('reports a completed persisted record even after unrelated writes pruned its pending nonce, keeping it until shown', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed || first.unproven) throw new Error('No original payment')
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    await settlePendingWrites(OWNER, YAPPR_CONTRACT_ID)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toHaveLength(0)
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(storedPayments()).toHaveLength(1)
  })

  /** Tabs A and B both show the QR at 101; its nonce is then retired without it (proved absent). */
  const shownThenRetired = async () => {
    const original = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (original.completed || original.unproven) throw new Error('No original payment')
    for (let nonce = BigInt(102); nonce <= BigInt(126); nonce++) expect(execute(nonce, false)).toBe(true)
    reportedNonce = chainNonce()
    return original.payment
  }

  it.each((['executable', 'completed', 'completed and cleared', 'unknown'] as const).flatMap(state =>
    [false, true].map(cached => ({ state, cached }))
  ))('settles a local confirmation by a $state QR another tab shows while it waits for its key (cached: $cached)', async ({ state, cached }) => {
    const original = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (original.completed || original.unproven) throw new Error('No original payment')
    for (let nonce = BigInt(102); nonce <= BigInt(126); nonce++) expect(execute(nonce, false)).toBe(true)
    reportedNonce = chainNonce()

    let resumeSigner = () => {}
    let signerStarted = () => {}
    const paused = new Promise<void>(resolve => { resumeSigner = resolve })
    const started = new Promise<void>(resolve => { signerStarted = resolve })
    vi.spyOn(sdk.identities, 'fetch').mockImplementationOnce(async () => {
      signerStarted()
      await paused
      return { publicKeys: [identityKey] }
    })
    const onPrepared = vi.fn()
    const sending = sendPayment({ key: context.key, startedAt: context.startedAt, cached: cached ? original.payment : undefined, onPrepared })
    await started
    let replacement: WalletPayment
    try {
      // Tab B checks the QR again: proved unpaid, so it shows a new one.
      const expose = vi.fn()
      const prepared = await prepareWalletPayment(original.payment, buildCachedPayment, { ...context, expose })
      if (prepared.completed || prepared.unproven || prepared.unresolved) throw new Error('No new QR')
      replacement = prepared.payment
      expect(expose).toHaveBeenCalledWith(replacement)
      expect(replacement.request.nonce).toBe(BigInt(127))
      expect(storedPayments().map(record => record.reservationId)).toEqual([replacement.request.reservationId])
      if (state === 'completed' || state === 'completed and cleared') {
        expect(execute(replacement.request.nonce, true)).toBe(true)
        recordReceipt(replacement)
        reportedNonce = chainNonce()
        // Tab B saw its QR paid and showed that before tab A had its key.
        if (state === 'completed and cleared') await clearPersistedWalletPayment(OWNER, replacement)
      } else if (state === 'unknown') {
        for (let nonce = BigInt(128); nonce <= BigInt(152); nonce++) expect(execute(nonce, false)).toBe(true)
        reportedNonce = chainNonce()
        historyHeight = BigInt(199)
      }
    } finally { resumeSigner() }
    const result = await sending
    expect(sdk.tokens.transfer).not.toHaveBeenCalled()
    expect(sdk.tokens.directPurchase).not.toHaveBeenCalled()
    if (state === 'executable') {
      // Signed at the new QR's own nonce: only one of the two can execute.
      expect(result).toEqual({ success: true })
      expect(execute(replacement.request.nonce, true)).toBe(false)
      expect(payments).toBe(1)
      const transition = StateTransition.fromBytes(localBytes)
      try { expect(transition.identityContractNonce).toBe(replacement.request.nonce) }
      finally { transition.free() }
    } else if (state === 'completed') {
      expect(result).toEqual({ success: true })
      expect(broadcast).not.toHaveBeenCalled()
      expect(payments).toBe(1)
      expect(onPrepared).toHaveBeenCalledWith({ completed: true, payment: expect.objectContaining({ request: expect.objectContaining({ nonce: BigInt(127) }) }) })
    } else if (state === 'completed and cleared') {
      // Tab B showed its QR paid after this confirmation started: the user decides.
      expect(result).toMatchObject({ success: false, errorCode: 'PAID_ELSEWHERE', error: PAID_ELSEWHERE_MESSAGE, payAgain: { key: context.key } })
      expect(broadcast).not.toHaveBeenCalled()
      expect(payments).toBe(1)
    } else {
      // The new QR's outcome can't be proved just now: checked again later, nothing sent meanwhile.
      expect(result).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
      expect(broadcast).not.toHaveBeenCalled()
      expect(payments).toBe(0)
    }
  })

  it.each(['a QR', 'its own key'] as const)('never signs a confirmation waiting for its key with nothing stored once another tab pays it with %s', async how => {
    let resumeSigner = () => {}
    let signerStarted = () => {}
    const paused = new Promise<void>(resolve => { resumeSigner = resolve })
    const started = new Promise<void>(resolve => { signerStarted = resolve })
    vi.spyOn(sdk.identities, 'fetch').mockImplementationOnce(async () => {
      signerStarted()
      await paused
      return { publicKeys: [identityKey] }
    })
    const freshWrite = action === 'tip' ? sdk.tokens.transfer : sdk.tokens.directPurchase
    const waiting = sendPayment({ key: context.key, startedAt: context.startedAt })
    await started
    try {
      if (how === 'a QR') {
        // Tab B shows a QR for the same payment, the wallet pays it, and B shows it paid.
        const shown = await shownPayment()
        expect(execute(shown.request.nonce, true)).toBe(true)
        recordReceipt(shown)
        reportedNonce = chainNonce()
        expect(await prepareWalletPayment(shown, buildCachedPayment, context)).toMatchObject({ completed: true })
        await clearPersistedWalletPayment(OWNER, shown)
        expect(storedPayments()).toEqual([])
      } else {
        expect(await sendPayment({ key: context.key, startedAt: Date.now() })).toEqual({ success: true })
        expect(freshWrite).toHaveBeenCalledOnce()
      }
    } finally { resumeSigner() }
    const result = await waiting
    expect(result).toMatchObject({ success: false, errorCode: 'PAID_ELSEWHERE', error: PAID_ELSEWHERE_MESSAGE, payAgain: { key: context.key } })
    const paidBefore = freshWrite.mock.calls.length + payments
    // Paying again is the user's choice, made for this payment.
    const consent = result.payAgain
    if (consent?.restartAt === undefined) throw new Error('No choice offered')
    expect(await sendPayment({ key: context.key, startedAt: consent.restartAt, payAgain: consent })).toEqual({ success: true })
    expect(freshWrite.mock.calls.length + payments).toBe(paidBefore + 1)
    expect(paidBefore).toBe(1)
  })

  it('asks before showing its QR again once another request of the same payment went through, and counts that one shown', async () => {
    const shown = await shownPayment()
    // Another tab chose to pay again: a second request of the same payment, which the wallet pays.
    const other = await prepareWalletPayment(undefined, buildCachedPayment, { ...context, key: 'another' })
    if (other.completed || other.unproven) throw new Error('No second request')
    storeWalletPayments(OWNER, YAPPR_CONTRACT_ID, scopedKey('wallet-payments:v1'), JSON.stringify(storedPayments().map(record => ({ ...record, key: context.key }))))
    expect(execute(other.payment.request.nonce, true)).toBe(true)
    recordReceipt(other.payment)
    reportedNonce = chainNonce()
    const asked = await prepareWalletPayment(shown, buildCachedPayment, context)
    if (!asked.unproven) throw new Error('Not asked')
    expect(asked).toMatchObject({ completed: false, unproven: true, paidElsewhere: true })
    expect(storedPayments().map(record => record.reservationId)).toEqual([shown.request.reservationId])
    expect(await sendPayment({ key: context.key, startedAt: context.startedAt, cached: shown })).toMatchObject({ success: false, errorCode: 'PAID_ELSEWHERE' })
    expect(broadcast).not.toHaveBeenCalled()
    const again = await prepareWalletPayment(shown, buildCachedPayment, { ...context, startedAt: asked.consent.restartAt ?? 0, payAgain: asked.consent })
    expect(again).toEqual({ completed: false, payment: shown })
    expect(payments).toBe(1)
  })

  it('refuses a payment started longer ago than completed payments are remembered, and forgets older completions', async () => {
    const completedKey = `${scopedKey('wallet-payments:v1')}:completed`
    storeWalletPayments(OWNER, YAPPR_CONTRACT_ID, completedKey, JSON.stringify([{ key: context.key, completedAt: Date.now() - COMPLETION_RETENTION_MS }]))
    const stale = { ...context, startedAt: Date.now() - COMPLETION_RETENTION_MS }
    const buildFresh = vi.fn(buildCachedPayment)
    await expect(prepareWalletPayment(undefined, buildFresh, stale)).rejects.toBeInstanceOf(StalePaymentError)
    expect(await sendPayment({ key: context.key, startedAt: stale.startedAt })).toMatchObject({ success: false, error: new StalePaymentError().message })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(loadWalletPayments(OWNER, YAPPR_CONTRACT_ID, completedKey)).toBe('[]')
  })

  it('never builds a second QR for a payment another tab shows, nor signs it at a fresh nonce', async () => {
    const inA = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (inA.completed || inA.unproven) throw new Error('No QR in tab A')
    const buildFresh = vi.fn(buildCachedPayment)
    const inB = await prepareWalletPayment(undefined, buildFresh, context)
    if (inB.completed || inB.unproven) throw new Error('No QR in tab B')
    expect(buildFresh).not.toHaveBeenCalled()
    expect(inB.payment.request.reservationId).toBe(inA.payment.request.reservationId)
    expect(inB.payment.request.bytes).toEqual(inA.payment.request.bytes)
    expect(await sendPayment({ key: context.key, startedAt: context.startedAt })).toEqual({ success: true })
    expect(execute(inA.payment.request.nonce, true)).toBe(false)
    expect(payments).toBe(1)
  })

  it('reports a paid QR only once the confirmation that shows it clears it, so an abandoned check loses nothing', async () => {
    const shown = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (shown.completed || shown.unproven) throw new Error('No QR payment')
    expect(execute(shown.payment.request.nonce, true)).toBe(true)
    recordReceipt(shown.payment)
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    // A check after a reload, abandoned before it showed anything.
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: true, payment: { request: { reservationId: shown.payment.request.reservationId } } })
    expect(storedPayments()).toHaveLength(1)
    expect(await prepareLocalWalletPayment(undefined, context)).toMatchObject({ completed: true })
    await clearPersistedWalletPayment(OWNER, shown.payment)
    expect(storedPayments()).toEqual([])
    expect(buildFresh).not.toHaveBeenCalled()
    expect(payments).toBe(1)
  })

  it('asks before paying again for a shown QR proved unpaid with nothing stored after it, and lets other payments through', async () => {
    const original = await shownThenRetired()
    // Another tab proved it unpaid and dropped it; what it did next can't be told here.
    dropStored(original.request.reservationId)
    const buildFresh = vi.fn(buildCachedPayment)
    const consent = { key: context.key, evidence: `unpaid:${original.request.reservationId}` }
    expect(await prepareWalletPayment(original, buildFresh, context)).toEqual({ completed: false, unproven: true, consent })
    expect(await prepareLocalWalletPayment(original, context)).toEqual({ completed: false, unproven: true, consent })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(await prepareLocalWalletPayment(undefined, { ...context, key: 'different payment' })).toEqual({ completed: false })
    // Consent covers only what it was given for.
    expect(await prepareWalletPayment(original, buildFresh, { ...context, payAgain: unreadable })).toMatchObject({ unproven: true })
    expect(await prepareWalletPayment(original, buildFresh, { ...context, payAgain: { ...consent, key: 'different payment' } })).toMatchObject({ unproven: true })
    expect(buildFresh).not.toHaveBeenCalled()
    const again = await prepareWalletPayment(original, buildFresh, { ...context, payAgain: consent })
    if (again.completed || again.unproven) throw new Error('Not paid again')
    expect(buildFresh).toHaveBeenCalledOnce()
    expect(again.payment.request.nonce).toBe(BigInt(127))
    // The new request is stored and protected like any other: a fresh confirmation shows it again.
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: false, payment: { request: { reservationId: again.payment.request.reservationId } } })
    expect(buildFresh).toHaveBeenCalledOnce()
  })

  /** The shown request's stored transition becomes unreadable; its nonce stays readable. */
  const corruptStoredRequest = async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed || first.unproven) throw new Error('No QR payment')
    const key = [...storage.keys()].find(item => item.startsWith('yappr:wallet-payments:'))
    if (!key) throw new Error('No stored requests')
    const records = JSON.parse(storage.get(key) ?? '[]') as { bytes: string }[]
    records[0].bytes = 'AAAA'
    storage.set(key, JSON.stringify(records))
    return { first: first.payment, key }
  }

  it('asks before paying again past an unreadable stored request of the same payment, paid or not, and never for another payment', async () => {
    const { first } = await corruptStoredRequest()
    // The wallet paid it before the reload.
    expect(execute(first.request.nonce, true)).toBe(true)
    recordReceipt(first)
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: false, unproven: true, consent: unreadable })
    expect(await prepareLocalWalletPayment(undefined, context)).toMatchObject({ completed: false, unproven: true, consent: unreadable })
    expect(await sendPayment({ key: context.key, startedAt: context.startedAt })).toMatchObject({ success: false, errorCode: 'MAY_HAVE_PAID', error: MAY_HAVE_PAID_MESSAGE, payAgain: unreadable })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(payments).toBe(1)
    expect(await prepareLocalWalletPayment(undefined, { ...context, key: 'different payment' })).toEqual({ completed: false })
    expect(await prepareWalletPayment(undefined, buildFresh, { ...context, payAgain: { ...unreadable, key: 'different payment' } })).toMatchObject({ unproven: true })
    const again = await prepareWalletPayment(undefined, buildFresh, { ...context, payAgain: unreadable })
    if (again.completed || again.unproven) throw new Error('Not paid again')
    expect(again.payment.request.nonce).toBe(BigInt(102))
    // The choice was this confirmation's: the unreadable request stays, and the next one asks again.
    expect(storedPayments().map(record => record.reservationId)).toContain(first.request.reservationId)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: false, unproven: true, consent: unreadable })
    // Checked again without the choice, the confirmation that made it shows its own QR again and builds nothing.
    expect(await prepareWalletPayment(again.payment, buildFresh, context)).toEqual({ completed: false, payment: again.payment })
    expect(buildFresh).toHaveBeenCalledOnce()
  })

  it.each([['that cannot be parsed', '{'], ['holding an empty string', ''], ['holding an entry without a nonce', '[{}]']])('asks every confirmation before paying again past stored requests %s', async (_label, raw) => {
    const { key } = await corruptStoredRequest()
    storage.set(key, raw)
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: false, unproven: true, consent: unreadable })
    expect(await prepareLocalWalletPayment(undefined, { ...context, key: 'different payment' })).toMatchObject({ completed: false, unproven: true, consent: { key: 'different payment', evidence: 'unreadable' } })
    expect(buildFresh).not.toHaveBeenCalled()
    const next = await prepareWalletPayment(undefined, buildFresh, { ...context, payAgain: unreadable })
    expect(next).toMatchObject({ completed: false, payment: { request: { nonce: BigInt(102) } } })
    expect(storedPayments()).toHaveLength(1)
    // Set aside, not dropped: a confirmation that hasn't chosen still asks.
    expect([...storage.entries()].some(([name, value]) => name !== key && name.startsWith('yappr:wallet-payments:') && value === JSON.stringify([raw]))).toBe(true)
    expect(await prepareLocalWalletPayment(undefined, { ...context, key: 'different payment' })).toMatchObject({ completed: false, unproven: true, consent: { key: 'different payment', evidence: 'unreadable' } })
  })

  it('keeps every readable stored request when a confirmation pays again past an unreadable one', async () => {
    const shown = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (shown.completed || shown.unproven) throw new Error('No QR payment')
    const key = [...storage.keys()].find(item => item.startsWith('yappr:wallet-payments:'))
    if (!key) throw new Error('No stored requests')
    const raw = JSON.stringify([...JSON.parse(storage.get(key) ?? '[]') as unknown[], { reservationId: 'broken' }])
    storage.set(key, raw)
    expect(await prepareLocalWalletPayment(undefined, { ...context, payAgain: unreadable }))
      .toMatchObject({ completed: false, payment: { request: { reservationId: shown.payment.request.reservationId } } })
    expect(storedPayments().map(record => record.reservationId)).toEqual([shown.payment.request.reservationId])
  })

  it('asks before paying again when a request of the same payment may have paid, even with a newer one stored after it', async () => {
    const { first } = await corruptStoredRequest()
    // Another tab chose to pay again and shows a new QR, then closes without it being paid.
    const other = await prepareWalletPayment(undefined, buildCachedPayment, { ...context, payAgain: unreadable })
    if (other.completed || other.unproven) throw new Error('No new QR')
    expect(other.payment.request.nonce).toBeGreaterThan(first.request.nonce)
    // After a reload, neither signing method takes the newer request without this confirmation choosing to.
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(undefined, buildFresh, context)).toMatchObject({ completed: false, unproven: true, consent: unreadable })
    expect(await sendPayment({ key: context.key, startedAt: context.startedAt })).toMatchObject({ success: false, errorCode: 'MAY_HAVE_PAID' })
    expect(broadcast).not.toHaveBeenCalled()
    expect(buildFresh).not.toHaveBeenCalled()
    // Once it chooses, the newer request is shown again rather than a third one built.
    expect(await prepareWalletPayment(undefined, buildFresh, { ...context, payAgain: unreadable })).toMatchObject({ completed: false, payment: { request: { reservationId: other.payment.request.reservationId } } })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('takes over a stored request of the same payment that can still execute once its own was proved absent', async () => {
    const original = await shownThenRetired()
    // Tab B opens the same payment: the request proved absent gives way to a new QR, not yet paid.
    const inB = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (inB.completed || inB.unproven || inB.unresolved) throw new Error('No QR in tab B')
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(original, buildFresh, context)).toMatchObject({ completed: false, payment: { request: { reservationId: inB.payment.request.reservationId } } })
    expect(await prepareLocalWalletPayment(original, context)).toMatchObject({ completed: false, payment: { request: { reservationId: inB.payment.request.reservationId } } })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('keeps a shown request through a tab of the earlier build rewriting the nonce reservation', async () => {
    const shown = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (shown.completed || shown.unproven) throw new Error('No QR payment')
    const key = [...storage.keys()].find(item => item.startsWith('yappr:nonce-reservation:'))
    if (!key) throw new Error('No reservation')
    // The earlier build writes the reservation as mark, floor and pending only (a document at 102, say).
    const base = JSON.parse(storage.get(key) ?? '{}') as { floor: string; pending: unknown[] }
    storage.set(key, JSON.stringify({ mark: '102', floor: base.floor, pending: base.pending }))
    const buildFresh = vi.fn(buildCachedPayment)
    const again = await prepareWalletPayment(undefined, buildFresh, context)
    if (again.completed || again.unproven) throw new Error('Reported completed')
    expect(buildFresh).not.toHaveBeenCalled()
    expect(again.payment.request.reservationId).toBe(shown.payment.request.reservationId)
  })

  it('takes liveness and outcome from one read of the nonce', async () => {
    const cached = await shownPayment()
    const before = sdk.identities.contractNonceWithProof.mock.calls.length
    // Executable at that read; the wallet pays just after it.
    sdk.identities.contractNonceWithProof.mockImplementationOnce(async () => {
      const answer = { data: reportedNonce, metadata: { height: nonceHeight }, proof: {} }
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      reportedNonce = chainNonce()
      return answer
    })
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached })
    expect(sdk.identities.contractNonceWithProof.mock.calls.length - before).toBe(1)
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('serializes two tabs preparing the same payment under the reservation lock', async () => {
    const buildFresh = vi.fn(buildCachedPayment)
    const [first, second] = await Promise.all([
      prepareWalletPayment(undefined, buildFresh, context),
      prepareWalletPayment(undefined, buildFresh, context),
    ])
    if (first.completed || first.unproven || second.completed || second.unproven) throw new Error('No payment to compare')
    expect(first.payment.request.bytes).toEqual(second.payment.request.bytes)
    expect(buildFresh).toHaveBeenCalledOnce()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  if (action === 'tip') {
    it('does not call a clock-skewed landed tip absent', async () => {
      const chainTime = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(chainTime + 180_000)
      const cached = await shownPayment()
      recordPayment()
      sentTips = [{ id: 'landed', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: 'same payment', createdAt: new Date(chainTime) }]
      reportedNonce = BigInt(126)
      expect(await cached.checkOutcome()).toBe('completed')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toMatchObject({ completed: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it('matches a literal-note profile tip even when history parses its note as a post target', async () => {
      const note = 'yappr:tip:v1:post:' + OTHER
      const payment = await buildWalletTip(OWNER, OTHER, BigInt(100), undefined, note)
      recordReceipt(payment)
      reportedNonce = BigInt(101)
      sentTips = [{ id: 'literal-note', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: note, postId: OTHER, targetKind: 'post', createdAt: new Date() }]
      expect(await payment.checkOutcome()).toBe('completed')
      expect(await prepareWalletPayment(payment, buildCachedPayment, context)).toMatchObject({ completed: true })
    })

    it('clears a proved-absent persisted record before building its replacement', async () => {
      const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
      if (first.completed || first.unproven) throw new Error('No original payment')
      reportedNonce = BigInt(126)
      const buildFresh = vi.fn(async (lockHeld = false) => {
        expect(storedPayments()).toEqual([])
        return buildCachedPayment(lockHeld)
      })
      const next = await prepareWalletPayment(undefined, buildFresh, context)
      if (next.completed || next.unproven || next.unresolved) throw new Error('Proved-absent payment was retained')
      expect(next.payment.request.nonce).toBe(BigInt(127))
      expect(storedPayments()).toEqual([{ ...storedPayments()[0], nonce: '127' }])
      expect(storedPayments()[0].reservationId).not.toBe(first.payment.request.reservationId)
    })

    it.each(['unreadable', 'incomplete'])('uses the exact receipt even when sender history is %s', async state => {
      if (state === 'unreadable') vi.mocked(tipHistoryService.getTipsSentWithProof).mockRejectedValueOnce(new Error('no baseline'))
      else sentTips = Array.from({ length: TIP_PAGE_LIMIT }, (_, index) => ({ id: String(index), from: OWNER, to: OTHER, amount: BigInt(1), createdAt: new Date() }))
      const cached = await shownPayment()
      recordPayment()
      reportedNonce = BigInt(101)
      expect(await cached.checkOutcome()).toBe('completed')
      expect(tipHistoryService.getTipsSentWithProof).not.toHaveBeenCalled()
    })

    it('does not mistake an identical transfer from the baseline for a new tip', async () => {
      recordPayment()
      const cached = await shownPayment()
      reportedNonce = BigInt(126)
      expect(await cached.checkOutcome()).toBe('absent')
    })
  }

  it('confirms a payment landing after the polling timeout and before Check again', async () => {
    vi.useFakeTimers()
    const cached = await shownPayment()
    expect(await cached.checkOutcome()).toBe('unknown')
    await vi.advanceTimersByTimeAsync(300_001)
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toMatchObject({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(payments).toBe(1)
  })

  if (action === 'tip') {
    it.each(['wallet retry then local fallback', 'local fallback'] as const)('replaces an expired absent payment for %s, sharing the new nonce', async path => {
      const cached = await shownPayment()
      for (let nonce = BigInt(102); nonce <= BigInt(126); nonce++) expect(execute(nonce, false)).toBe(true)
      reportedNonce = chainNonce()
      expect(identityContractNonceConsumed(reportedNonce, BigInt(101))).toBe(true)
      const buildFresh = vi.fn(buildCachedPayment)
      const prepared = await prepareWalletPayment(cached, buildFresh, context)
      expect(prepared.completed).toBe(false)
      if (prepared.completed || prepared.unproven) throw new Error('Absent payment was reported completed')
      const replacement = prepared.payment
      expect(replacement).not.toBe(cached)
      expect(buildFresh).toHaveBeenCalledOnce()
      if (path === 'wallet retry then local fallback') {
        const local = await prepareWalletPayment(replacement, buildFresh, context)
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
    const cached = await shownPayment()
    expect(execute(BigInt(102), false)).toBe(true)
    reportedNonce = chainNonce()
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(await sendPayment(cached.request)).toEqual({ success: true })
    expect(payments).toBe(1)
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it('keeps the original request when the liveness read fails', async () => {
    const cached = await shownPayment()
    sdk.identities.contractNonceWithProof.mockRejectedValueOnce(new Error('proof unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached, unresolved: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
  })

  it('keeps an expired request when the payment outcome read fails', async () => {
    const cached = await shownPayment()
    reportedNonce = BigInt(126)
    sdk.documents.getWithProof.mockRejectedValueOnce(new Error('receipt unavailable'))
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached, unresolved: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  it('reads the outcome after liveness so a payment landing during that read cannot be replaced', async () => {
    const cached = await shownPayment()
    sdk.identities.contractNonceWithProof.mockImplementationOnce(async () => {
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      reportedNonce = chainNonce()
      return { data: reportedNonce, metadata: { height: nonceHeight }, proof: {} }
    })
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toMatchObject({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
  })

  if (action === 'purchase') {
    it('confirms the exact purchase receipt even when spending masks its balance rise', async () => {
      const cached = await shownPayment()
      expect(execute(BigInt(101), true)).toBe(true)
      recordPayment()
      balance -= BigInt(100)
      reportedNonce = chainNonce()
      expect(balance).toBe(BigInt(500))
      expect(await cached.checkOutcome()).toBe('completed')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toMatchObject({ completed: true })
      expect(buildFresh).not.toHaveBeenCalled()
      expect(payments).toBe(1)
    })

    it('replaces a purchase only after proved receipt absence and nonce consumption', async () => {
      const cached = await shownPayment()
      reportedNonce = BigInt(126)
      const buildFresh = vi.fn(buildCachedPayment)
      const next = await prepareWalletPayment(cached, buildFresh, context)
      expect(next).toMatchObject({ completed: false })
      expect(buildFresh).toHaveBeenCalledOnce()
    })

    it('ignores unrelated balance changes across retries', async () => {
      const cached = await shownPayment()
      balance = BigInt(450)
      expect(await cached.checkOutcome()).toBe('unknown')
      balance = BigInt(550)
      expect(await prepareWalletPayment(cached, buildCachedPayment, context)).toEqual({ completed: false, payment: cached })
    })
  } else {
    it('keeps a consumed request when the outcome proof is a block behind', async () => {
      const cached = await shownPayment()
      expect(execute(BigInt(101), true)).toBe(true)
      reportedNonce = chainNonce()
      historyHeight = BigInt(199)
      expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached, unresolved: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it.each([BigInt(200), BigInt(201)])('rebuilds only when absence is proved at height %s, at or above consumption', async height => {
      const cached = await shownPayment()
      reportedNonce = BigInt(126)
      historyHeight = height
      expect(await cached.checkOutcome()).toBe('absent')
      const buildFresh = vi.fn(buildCachedPayment)
      const prepared = await prepareWalletPayment(cached, buildFresh, context)
      expect(prepared.completed).toBe(false)
      if (prepared.completed || prepared.unproven) throw new Error('Absent tip was reported completed')
      expect(prepared.payment).not.toBe(cached)
      expect(buildFresh).toHaveBeenCalledOnce()
    })

    it('keeps the request when the nonce is still free despite current empty history', async () => {
      const cached = await shownPayment()
      expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it.each(['nonce proof', 'nonce height', 'outcome proof', 'outcome height'])('keeps a consumed request when %s is unavailable', async missing => {
      const cached = await shownPayment()
      reportedNonce = BigInt(126)
      if (missing === 'nonce proof') sdk.identities.contractNonceWithProof.mockResolvedValueOnce({ data: reportedNonce, metadata: { height: nonceHeight } })
      if (missing === 'nonce height') nonceHeight = undefined
      if (missing === 'outcome proof') sdk.documents.getWithProof.mockResolvedValue({ data: undefined, metadata: { height: historyHeight } })
      if (missing === 'outcome height') historyHeight = undefined
      if (missing.startsWith('outcome')) expect(await cached.checkOutcome()).toBe('unknown')
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached, unresolved: true })
      expect(buildFresh).not.toHaveBeenCalled()
    })

    it('proves exact receipt absence even when sender history is a full page', async () => {
      const cached = await shownPayment()
      reportedNonce = BigInt(126)
      sentTips = Array.from({ length: TIP_PAGE_LIMIT }, (_, index) => ({
        id: `other-${index}`, from: OWNER, to: OTHER, amount: BigInt(1), createdAt: new Date(),
      }))
      const buildFresh = vi.fn(buildCachedPayment)
      expect(await prepareWalletPayment(cached, buildFresh, context)).toMatchObject({ completed: false })
      expect(buildFresh).toHaveBeenCalledOnce()
    })
  }

  it('uses the SDK receipt id derived from the owner, token, type and big-endian reserved nonce', async () => {
    const cached = await shownPayment()
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
    if (first.completed || first.unproven) throw new Error('No original payment')
    expect(execute(BigInt(101), true)).toBe(true)
    recordPayment()
    reportedNonce = chainNonce()
    await clearPersistedWalletPayment(OWNER, first.payment)
    expect(storedPayments()).toEqual([])
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(first.payment, buildFresh, context)).toMatchObject({ completed: true })
    expect(await prepareLocalWalletPayment(first.payment, context)).toMatchObject({ completed: true })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.mark).toBe(BigInt(101))
    expect(payments).toBe(1)
  })

  it('shows a cached request missing from storage again, and stores it, while it can still execute', async () => {
    const cached = { ...await buildCachedPayment(), key: context.key }
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(cached, buildFresh, context)).toEqual({ completed: false, payment: cached })
    expect(buildFresh).not.toHaveBeenCalled()
    expect(storedPayments().map(record => record.reservationId)).toEqual([cached.request.reservationId])
  })

  it('does not complete a matching transfer or unrelated balance rise while the nonce is unconsumed', async () => {
    const first = await prepareWalletPayment(undefined, buildCachedPayment, context)
    if (first.completed || first.unproven) throw new Error('No original payment')
    recordPayment()
    expect(await first.payment.checkOutcome()).toBe('unknown')
    const buildFresh = vi.fn(buildCachedPayment)
    expect(await prepareWalletPayment(first.payment, buildFresh, context)).toMatchObject({ completed: false })
    expect(storedPayments()).toHaveLength(1)
    expect(buildFresh).not.toHaveBeenCalled()
    expect(sdk.documents.getWithProof).not.toHaveBeenCalled()
  })

  it('does not confuse a lagging baseline or an unrelated balance rise with this consumed payment', async () => {
    const cached = await shownPayment()
    balance += BigInt(100)
    sentTips = [{ id: 'older-identical-tip', from: OWNER, to: OTHER, amount: BigInt(100), publicNote: 'same payment', createdAt: new Date() }]
    reportedNonce = BigInt(126)
    expect(await cached.checkOutcome()).toBe('absent')
    expect(sdk.documents.getWithProof).toHaveBeenLastCalledWith(TOKEN_HISTORY_CONTRACT_ID, action === 'tip' ? 'transfer' : 'directPurchase', receiptId(cached.request.bytes))
  })

  it('a local-only key-sheet cancel never allocates or persists a wallet request', async () => {
    const local = await prepareLocalWalletPayment(undefined, context)
    if (local.completed || local.unproven) throw new Error('No local attempt')
    readPrivateKey.mockImplementationOnce(() => { throw new CriticalKeyCancelledError() })
    expect(await sendPayment(local.payment?.request)).toMatchObject({ success: false, errorCode: 'CANCELLED' })
    expect(storedPayments()).toEqual([])
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toBeNull()
    const different = await prepareWalletPayment(undefined, buildCachedPayment, { ...context, key: 'different' })
    if (different.completed || different.unproven || different.unresolved) throw new Error('Different payment was blocked')
    expect(different.payment.request.nonce).toBe(BigInt(101))
  })

  it.each(['cancel', 'chosen write not sent'] as const)('a local-only %s leaves no wallet record or reservation and does not block the next different payment', async failure => {
    // A retired earlier write forces the normal local path to choose its nonce.
    const earlier = reserveNonce(OWNER, YAPPR_CONTRACT_ID, BigInt(101), BigInt(100), WALLET_TOKEN_SCOPE)
    releaseNonce(OWNER, YAPPR_CONTRACT_ID, earlier)
    const local = await prepareLocalWalletPayment(undefined, context)
    expect(local).toEqual({ completed: false })
    if (local.completed || local.unproven) throw new Error('No local payment was attempted')
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
    if (different.completed || different.unproven || different.unresolved) throw new Error('Different payment was blocked')
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
    if (first.completed || first.unproven) throw new Error('No original payment')
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
    expect(chosen).toHaveBeenCalledWith(BigInt(102), expect.any(Function))
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
