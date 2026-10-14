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
  identities: { fetch: vi.fn(), contractNonce: vi.fn(), contractNonceWithProof: vi.fn(), nonce: vi.fn(), balance: vi.fn(), creditTransfer: vi.fn() },
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

import { stateTransitionService } from './state-transition-service'
import { tipService } from './tip-service'

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

/** Run `work` with fake timers, letting every poll and backoff elapse. */
async function elapsing<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const pending = work()
    await vi.runAllTimersAsync()
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

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
  it('reports success, sending it once, when the chain shows the new revision', async () => {
    sdk.documents.replace.mockRejectedValue(qku())
    sdk.documents.get.mockResolvedValue(stored(3))

    const result = await stateTransitionService.updateDocument(CONTRACT, 'profile', 'doc', OWNER, { bio: 'new' }, 2)

    expect(sdk.documents.replace).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, document: { $revision: 3, bio: 'new' } })
  })

  it('reports the failure when the chain still shows the old revision, without sending again', async () => {
    sdk.documents.replace.mockRejectedValue(qku())
    sdk.documents.get.mockResolvedValue(stored(2))

    const result = await stateTransitionService.updateDocument(CONTRACT, 'profile', 'doc', OWNER, { bio: 'new' }, 2)

    expect(sdk.documents.replace).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
  })

  it('does not read a readback that failed on the gap as the old revision or as landed', async () => {
    sdk.documents.replace.mockRejectedValue(qku())
    sdk.documents.get.mockRejectedValue(qku())

    const result = await stateTransitionService.updateDocument(CONTRACT, 'profile', 'doc', OWNER, { bio: 'new' }, 2)

    expect(result.success).toBe(false)
    expect(sdk.documents.replace).toHaveBeenCalledTimes(1)
  })
})

describe('deleteDocument whose result proof could not be verified', () => {
  it('reports success when the document is gone', async () => {
    sdk.documents.delete.mockRejectedValue(qku())
    sdk.documents.get.mockResolvedValue(undefined)

    const result = await stateTransitionService.deleteDocument(CONTRACT, 'bookmark', 'doc', OWNER)

    expect(sdk.documents.delete).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, transactionHash: 'doc' })
  })

  it('never takes "Quorum not found in cache" on the readback for the document being gone', async () => {
    sdk.documents.delete.mockRejectedValue(qku())
    sdk.documents.get.mockRejectedValue(qku())

    const result = await stateTransitionService.deleteDocument(CONTRACT, 'bookmark', 'doc', OWNER)

    expect(result.success).toBe(false)
    expect(sdk.documents.delete).toHaveBeenCalledTimes(1)
  })

  it('reports a failure before anything was sent as a failure, without a readback', async () => {
    // The identity read hit the gap: no key was chosen and nothing was built.
    sdk.identities.fetch.mockRejectedValue(qku())

    const result = await stateTransitionService.deleteDocument(CONTRACT, 'bookmark', 'doc', OWNER)

    expect(result.success).toBe(false)
    expect(sdk.documents.delete).not.toHaveBeenCalled()
    expect(sdk.documents.get).not.toHaveBeenCalled()
  })
})

describe('a credit tip whose result proof could not be verified', () => {
  const SENDER = 'sender'
  const RECIPIENT = 'recipient'
  const AMOUNT = 200_000_000

  beforeEach(() => {
    sdk.identities.fetch.mockResolvedValue({ publicKeys: [{ keyId: 3 }] })
    sdk.identities.creditTransfer.mockRejectedValue(qku())
  })

  it("confirms it from the sender's nonce and balance, sending it once", async () => {
    sdk.identities.nonce.mockResolvedValueOnce(n(7)).mockResolvedValue(n(8))
    sdk.identities.balance
      .mockResolvedValueOnce(n(1_000_000_000))
      .mockResolvedValue(n(1_000_000_000 - AMOUNT - 1_000))

    const result = await elapsing(() => tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif'))

    expect(sdk.identities.creditTransfer).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true })
  })

  it('reports it unconfirmed, never as a bad key or a failure to retry, when the balance does not show it', async () => {
    sdk.identities.nonce.mockResolvedValueOnce(n(7)).mockResolvedValue(n(8))
    sdk.identities.balance.mockResolvedValue(n(1_000_000_000))

    const result = await elapsing(() => tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif'))

    expect(sdk.identities.creditTransfer).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
  })

  it('compares nonce sequences, so a gap that fills while the tip settles does not hide it', async () => {
    // Before: sequence 7 with nonce 6 still missing (bit 40); after: sequence 8, gap filled. The raw value drops.
    sdk.identities.nonce.mockResolvedValueOnce((n(1) << n(40)) | n(7)).mockResolvedValue(n(8))
    sdk.identities.balance
      .mockResolvedValueOnce(n(1_000_000_000))
      .mockResolvedValue(n(1_000_000_000 - AMOUNT - 1_000))

    const result = await elapsing(() => tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif'))

    expect(result).toMatchObject({ success: true })
  })

  it('does not take a balance drop for the tip while the nonce has not moved (another spend)', async () => {
    sdk.identities.nonce.mockResolvedValue(n(7))
    sdk.identities.balance
      .mockResolvedValueOnce(n(1_000_000_000))
      .mockResolvedValue(n(1_000_000_000 - AMOUNT - 1_000))

    const result = await elapsing(() => tipService.sendTip(SENDER, RECIPIENT, AMOUNT, 'transfer-wif'))

    expect(result).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
  })
})
