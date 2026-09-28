/**
 * QA D-01 review findings on `createDocument`: when a create's outcome is
 * unknown it must never be rebuilt under a new nonce (a second post, a second
 * charge), and a create whose nonce was consumed without its document may
 * only be called failed on proof, never on a lagging read. The SDK is mocked;
 * every test counts the transitions broadcast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { fetch: vi.fn(), contractNonce: vi.fn(), contractNonceWithProof: vi.fn() },
  documents: { get: vi.fn(), getWithProof: vi.fn() },
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
vi.mock('./document-builder-service', () => ({ documentBuilderService: { buildDocumentForCreate: async () => ({}) } }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: { keyId: 1, securityLevel: 1 }, match: { keyId: 1, securityLevel: 1 } }) }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('../auth-utils', () => ({ promptForAuthKey: () => undefined }))
vi.mock('./token-service', () => ({ tokenService: {} }))
vi.mock('./identity-service', () => ({ identityService: {} }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
})
vi.stubGlobal('window', {})

import { CREATE_NOT_RECORDED_ERROR, isIdentityNonceConflictError } from '@/lib/error-utils'
import { classifyWriteFailure } from './dm-v5/write-failure'
import { stateTransitionService } from './state-transition-service'

const OWNER = 'owner'
const CONTRACT = 'not-the-social-contract'
const NONCE_AT_TIP = 'state transition broadcast error: Identity owner is trying to set an invalid identity nonce. The current identity nonce is 101, we are setting 101, error is nonce already present at tip'
const n = (value: number) => BigInt(value)
const proved = <T>(data: T, height: number) => ({ data, metadata: { height: BigInt(height) } })

beforeEach(() => {
  storage.clear()
  vi.clearAllMocks()
  sdk.identities.fetch.mockResolvedValue({ publicKeys: [] })
  sdk.identities.contractNonce.mockResolvedValue(n(100))
  sdk.documents.get.mockResolvedValue(undefined)
})

describe('createDocument with an inconclusive outcome', () => {
  it('reports a nonce refusal it cannot settle as unconfirmed, and does not build another create', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockRejectedValue(new Error(NONCE_AT_TIP))
    // The settlement read fails: nothing is known about the create.
    sdk.identities.contractNonceWithProof.mockRejectedValue(new Error('transport error: unavailable'))

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, confirmed: false, transactionHash: 'doc-101' })
  })

  it('does not rebuild an indexOnly create refused for its nonce: the caller reads it back by value', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockRejectedValue(new Error(NONCE_AT_TIP))

    const result = await stateTransitionService.createDocument(CONTRACT, 'like', OWNER, { postId: 'p' }, { confirmation: 'affectedState' })

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
  })

  it('reports a timed-out wait on a create a lagging node shows absent as unconfirmed, not failed', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValue(new Error('waitForResponse timed out'))
    sdk.identities.contractNonceWithProof.mockResolvedValue(proved(n(101), 50))
    // Every document proof comes from a block below the one that showed the nonce consumed.
    sdk.documents.getWithProof.mockResolvedValue(proved(undefined, 49))

    vi.useFakeTimers()
    const pending = stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })
    await vi.runAllTimersAsync()
    const result = await pending
    vi.useRealTimers()

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, confirmed: false })
  })

  it('calls a create not recorded only on a proof of absence at or above the height that showed its nonce consumed', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValue(new Error('waitForResponse timed out'))
    sdk.identities.contractNonceWithProof.mockResolvedValue(proved(n(101), 50))
    sdk.documents.getWithProof.mockResolvedValue(proved(undefined, 50))

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(result).toEqual({ success: false, error: CREATE_NOT_RECORDED_ERROR })
    // Not a nonce clash: DM v5 must not rebuild it automatically.
    expect(isIdentityNonceConflictError(result.error)).toBe(false)
    expect(classifyWriteFailure(result.error ?? '')).not.toBe('nonce')
  })

  it('settles a 40204 the wait reports with its numeric code instead of returning a failure DM v5 would rebuild', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValue({ code: 40204, message: NONCE_AT_TIP, name: 'Protocol' })
    sdk.identities.contractNonceWithProof.mockRejectedValue(new Error('transport error: unavailable'))

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(sdk.identities.contractNonceWithProof).toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, confirmed: false })
  })

  it('reports a broadcast that failed without a verdict as unconfirmed, so no caller rebuilds it', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockRejectedValue(new Error('transport error: connection reset'))
    sdk.identities.contractNonceWithProof.mockRejectedValue(new Error('transport error: unavailable'))

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, confirmed: false })
  })

  it('waits on bytes already in the mempool rather than failing, even when the duplicate probe cannot answer', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockRejectedValue(new Error('state transition already in mempool'))
    sdk.documents.get.mockRejectedValue(new Error('transport error: unavailable'))
    sdk.stateTransitions.waitForResponse.mockResolvedValue({})

    const result = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'hi' })

    expect(result).toMatchObject({ success: true, confirmed: true })
  })

  it('takes the next create past a create whose outcome is unknown, so the two can never share a nonce', async () => {
    sdk.stateTransitions.broadcastStateTransition.mockResolvedValue(undefined)
    sdk.stateTransitions.waitForResponse.mockRejectedValueOnce(new Error('waitForResponse timed out')).mockResolvedValue({})
    sdk.identities.contractNonceWithProof.mockResolvedValue(proved(n(100), 50))

    const first = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'one' })
    const second = await stateTransitionService.createDocument(CONTRACT, 'post', OWNER, { text: 'two' })

    expect(first).toMatchObject({ success: true, confirmed: false, transactionHash: 'doc-101' })
    expect(second).toMatchObject({ success: true, confirmed: true, transactionHash: 'doc-102' })
  })
})
