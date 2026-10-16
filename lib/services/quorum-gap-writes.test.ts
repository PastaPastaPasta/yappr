/**
 * Platform 5.0.0-beta.6 QA on sakura: for ~15–20 s around every quorum
 * rotation a write's result proof fails with `QuorumKeyUnavailable`, and a
 * create reported that way had LANDED. These pin that a write whose answer
 * could not be verified is never re-sent, never reported failed while the
 * chain shows it landed, and never read back as absent on a failed read. The
 * SDK is mocked; every test counts what was sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { fetch: vi.fn(), contractNonce: vi.fn(), contractNonceWithProof: vi.fn(), balance: vi.fn(), creditTransfer: vi.fn() },
  documents: { get: vi.fn(), getWithProof: vi.fn(), replace: vi.fn(), delete: vi.fn() },
  stateTransitions: { broadcastStateTransition: vi.fn(), waitForResponse: vi.fn(), waitForAffectedState: vi.fn() },
  wasm: { refreshIdentityNonce: vi.fn(async () => undefined) },
}))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('@dashevo/evo-sdk', () => ({
  Identifier: class { constructor(readonly id: string) {} },
  PrivateKey: { fromWIF: () => ({}) },
  StateTransition: { fromBytes: () => ({}) },
  TokenPaymentInfo: class {},
  DocumentActionFeeAgreement: class {},
}))
vi.mock('@/lib/document-id', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-id')>()),
  documentIdForCreate: ({ identityContractNonce }: { identityContractNonce: bigint }) => `doc-${identityContractNonce}`,
}))
vi.mock('@/lib/manual-batch', () => ({
  buildSignedCreateTransition: ({ identityContractNonce }: { identityContractNonce: bigint }) => ({ nonce: identityContractNonce, toBytes: () => new Uint8Array([1]) }),
}))
vi.mock('./document-builder-service', () => ({
  documentBuilderService: {
    buildDocumentForCreate: async () => ({}),
    buildDocumentForReplace: async () => ({}),
    buildDocumentForDelete: () => ({}),
  },
}))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: async () => ({ signer: {}, identityKey: {} }) } }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: { keyId: 1, securityLevel: 1 }, match: { keyId: 1, securityLevel: 1 } }) }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif', hasPrivateKey: () => true }))
vi.mock('../auth-utils', () => ({ promptForAuthKey: () => undefined }))
vi.mock('./token-service', () => ({ tokenService: {} }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
})
vi.stubGlobal('window', {})

import { UNCONFIRMED_WRITE_MESSAGE, categorizeError } from '@/lib/error-utils'
import { stateTransitionService } from './state-transition-service'
import { tipService } from './tip-service'
import { tokenService } from './token-service'
import { tipHistoryService } from './tip-history-service'

const OWNER = 'owner'
const CONTRACT = 'not-the-social-contract'
const n = (value: number) => BigInt(value)
const proved = <T>(data: T, height: number) => ({ data, metadata: { height: BigInt(height) } })
/** wasm-sdk 5.0.0-beta.6 while the quorum source lags a rotation. */
const qku = () => ({
  name: 'Proof',
  kind: 4,
  code: -1,
  isRetriable: true,
  message: 'Proof verification error: quorum key unavailable for quorum 107:1c64a92f: invalid quorum: Quorum not found in cache for hash: 1c64a92f',
})
/** A stored document as `documents.get` returns it (`toObject`, read by documentToPlainObject). */
const stored = (revision: number) => ({ toObject: () => ({ $id: 'doc', $revision: revision }) })

beforeEach(() => {
  storage.clear()
  vi.clearAllMocks()
  sdk.identities.fetch.mockResolvedValue({ publicKeys: [] })
  sdk.identities.contractNonce.mockResolvedValue(n(100))
  sdk.documents.get.mockResolvedValue(undefined)
})

describe('createDocument whose result proof could not be verified', () => {
  it('confirms it by its derived id when the chain shows it, and sends it once', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValue(qku())
    sdk.identities.contractNonceWithProof.mockResolvedValue(proved(n(101), 50))
    sdk.documents.getWithProof.mockResolvedValue(proved(stored(1), 50))

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, confirmed: true, transactionHash: 'doc-101' })
  })

  it('reports it unconfirmed, never failed, while the readback cannot see it', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValue(qku())
    // The settlement reads hit the same gap.
    sdk.identities.contractNonceWithProof.mockRejectedValue(qku())

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, confirmed: false, transactionHash: 'doc-101' })
  })
})

describe('updateDocument whose result proof could not be verified', () => {
  it('never sends it again, and never reads success off a revision another device may have written', async () => {
    sdk.documents.replace.mockRejectedValue(qku())
    // Revision 3 is on chain, but it may be another device's replace, not this one.
    sdk.documents.get.mockResolvedValue(stored(3))

    const result = await stateTransitionService.updateDocument(CONTRACT, 'profile', 'doc', OWNER, { bio: 'new' }, 2)

    expect(sdk.documents.replace).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    // The caller shows "may have gone through, check" rather than an invitation to retry.
    expect(categorizeError(new Error(result.error))).toBe(UNCONFIRMED_WRITE_MESSAGE)
  })
})

describe('deleteDocument whose result proof could not be verified', () => {
  it('stays a failure that says it may have gone through, even when a read shows it absent, and is not sent again', async () => {
    sdk.documents.delete.mockRejectedValue(qku())
    // A node behind the document's creation answers "absent" too: no confirmation from it.
    sdk.documents.get.mockResolvedValue(undefined)

    const result = await stateTransitionService.deleteDocument(CONTRACT, 'bookmark', 'doc', OWNER)

    expect(sdk.documents.delete).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(categorizeError(new Error(result.error))).toBe(UNCONFIRMED_WRITE_MESSAGE)
  })

  it('reports a failure before anything was sent as a failure, sending nothing', async () => {
    // The identity read hit the gap: no key was chosen and nothing was built.
    sdk.identities.fetch.mockRejectedValue(qku())

    const result = await stateTransitionService.deleteDocument(CONTRACT, 'bookmark', 'doc', OWNER)

    expect(result.success).toBe(false)
    expect(sdk.documents.delete).not.toHaveBeenCalled()
  })
})

describe('a credit tip whose result proof could not be verified', () => {
  const SENDER = 'sender'
  const RECIPIENT = 'recipient'
  const AMOUNT = 200_000_000

  beforeEach(() => {
    sdk.identities.fetch.mockResolvedValue({ publicKeys: [{ keyId: 3 }] })
    sdk.identities.balance.mockResolvedValue(n(1_000_000_000))
  })

  it.each([
    ['an unverifiable result proof', qku()],
    ['a timed-out wait', new Error('waitForResponse timed out after 10s')],
    ['a transport failure', new Error('transport error: TypeError: Failed to fetch')],
    ['a nonce refusal', new Error('Identity sender is trying to set an invalid identity nonce. error is nonce already present at tip')],
  ])('reports it unconfirmed after %s, sending it once and never as a bad key or a failure to retry', async (_label, error) => {
    sdk.identities.creditTransfer.mockRejectedValue(error)

    const result = await tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif')

    expect(sdk.identities.creditTransfer).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
  })

  it('still reports a refusal as a failure', async () => {
    sdk.identities.creditTransfer.mockRejectedValue(new Error('state transition broadcast error: Identity sender has insufficient balance (code=40500)'))

    const result = await tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif')

    expect(result.success).toBe(false)
    expect(result.errorCode).not.toBe('UNCONFIRMED')
  })
})

describe('a YAPP tip sent without a verdict', () => {
  it('stays unconfirmed and is never matched against history, which an identical earlier tip would satisfy', async () => {
    const transfer = vi.fn(async () => ({ success: false, error: 'may have gone through', errorCode: 'UNCONFIRMED' as const }))
    Object.assign(tokenService, { transfer })
    const awaitSentTip = vi.spyOn(tipHistoryService, 'awaitSentTip').mockResolvedValue({} as Awaited<ReturnType<typeof tipHistoryService.awaitSentTip>>)

    const result = await tipService.sendYappTipLocal('sender', 'recipient', BigInt(10), { kind: 'post', id: '11111111111111111111111111111111' }, undefined, 'wif')

    expect(transfer).toHaveBeenCalledTimes(1)
    expect(awaitSentTip).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
  })

  it('reports a failure before the send as a failure, never matched against an earlier identical tip', async () => {
    // A quorum gap on the nonce read under the write lock: nothing was sent.
    const transfer = vi.fn(async () => ({ success: false, error: `Transfer failed: ${qku().message}`, errorCode: 'NETWORK_ERROR' as const }))
    Object.assign(tokenService, { transfer })
    const awaitSentTip = vi.spyOn(tipHistoryService, 'awaitSentTip').mockResolvedValue({} as Awaited<ReturnType<typeof tipHistoryService.awaitSentTip>>)

    const result = await tipService.sendYappTipLocal('sender', 'recipient', BigInt(10), { kind: 'post', id: '11111111111111111111111111111111' }, undefined, 'wif')

    expect(awaitSentTip).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
  })
})
