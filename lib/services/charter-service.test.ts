/**
 * Charters writes move money (the 0.5 DASH deposit) and leave permanent
 * documents (a proposal can never be deleted), so a create whose outcome is
 * unknown must never be re-signed under a new nonce, and may only be called
 * dead on proof: a read that fails or lags proves nothing. The SDK, the
 * builders and the nonce coordinator are mocked; every test counts what was
 * signed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { fetch: vi.fn() },
  stateTransitions: { broadcastAndWait: vi.fn() },
}))
const builders = vi.hoisted(() => ({ sign: vi.fn(), exists: vi.fn() }))
const settle = vi.hoisted(() => vi.fn())
const nonces = vi.hoisted(() => ({ reserve: vi.fn(), release: vi.fn(), next: 1n }))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('@dashevo/wasm-sdk', () => ({
  PrivateKey: { fromWIF: () => ({ free: () => undefined }) },
  StateTransition: { fromBytes: () => ({}) },
  Identifier: { fromBase58: () => ({ toBytes: () => new Uint8Array(32) }) },
}))
vi.mock('@/lib/moderation-charters/transitions.mjs', () => ({
  signCharterCreate: builders.sign,
  charterStepExists: builders.exists,
  charterIdBytes: () => new Uint8Array(32),
  charterKeyInCreation: () => ({}),
}))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { settleCreate: settle } }))
vi.mock('@/lib/identity-write-lock', () => ({ withIdentityWriteLock: (_o: string, _c: string, write: () => Promise<unknown>) => write() }))
vi.mock('./identity-nonce', () => ({
  awaitNonce: async () => ({ current: 0n, value: nonces.next++ }),
  allocateNonce: () => 1n,
  reserveNonce: nonces.reserve,
  releaseNonce: nonces.release,
  withSdkSignedWrite: (_o: string, _c: string, write: () => Promise<unknown>) => write(),
}))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: { keyId: 1 }, match: { keyId: 1 } }) }))
vi.mock('@/lib/secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/auth/signing-keys', () => ({ hasAppConnectSession: () => false }))
vi.mock('@/lib/retry-utils', () => ({ sleep: async () => undefined }))

const { charterService } = await import('./charter-service')

const OWNER = 'owner1'
// The service is one per page, so each test files for its own target (its own slot).
let TERMS = { targetContractId: 'target0', description: 'We hide spam.', reasonIds: ['r1'], moderatorsShare: 60, rewardSplit: { leader: 40, equal: 30, actions: 30 } }
let targets = 0
const timeout = () => Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })

beforeEach(() => {
  vi.clearAllMocks()
  nonces.next = 1n
  sdk.identities.fetch.mockResolvedValue({ publicKeys: [] })
  builders.sign.mockImplementation(async (_w: unknown, _sdk: unknown, { type, ownerId, nonce }: { type: string; ownerId: string; nonce: bigint }) => (
    { id: `doc-${nonce}`, type, owner: ownerId, nonce: String(nonce), bytes: new Uint8Array([Number(nonce)]), hash: 'h' }))
  nonces.reserve.mockImplementation((_o: string, _c: string, nonce: bigint) => ({ id: `r${nonce}`, nonce }))
  charterService.forgetKeys()
  TERMS = { ...TERMS, targetContractId: `target${++targets}` }
})

describe('an uncertain proposal', () => {
  it('keeps its signed bytes while readbacks fail, and resends them instead of signing a second proposal', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockRejectedValue(new Error('Quorum not found in cache'))
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(nonces.release).not.toHaveBeenCalled()
    // Both tries sent the same bytes.
    expect(sdk.stateTransitions.broadcastAndWait).toHaveBeenCalledTimes(2)
  })

  it('reports the proposal filed once it is proved, without signing again', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValueOnce(null).mockResolvedValueOnce('landed')
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), { id: 'r1', nonce: 1n }, 1n)
  })

  it('signs anew only once Platform proves the first one dead (nonce spent, document absent)', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
    builders.exists.mockResolvedValueOnce(false).mockResolvedValue(false)
    settle.mockResolvedValueOnce('not-recorded')
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'refused' })
    builders.exists.mockResolvedValue(true)
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-2')
    expect(builders.sign).toHaveBeenCalledTimes(2)
  })

  it('refuses changed terms while the first try may still land', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(charterService.submitProposal(OWNER, { ...TERMS, description: 'Edited.' })).rejects.toThrow('may still go through')
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })

  it('drops the bytes on a definite refusal, freeing the nonce reservation unspent', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('refused'), { code: 40120 }))
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'refused', code: 40120 })
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), { id: 'r1', nonce: 1n }, undefined)
  })
})

describe('an uncertain application', () => {
  it('is never declared dead: it lives in the contest, so its bytes are kept and settleCreate is not asked', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(false)
    const proposal = { id: 'p1', leaderId: OWNER, targetContractId: 'target1', description: '', reasonIds: [], moderatorsShare: 60, rewardSplit: null, createdAt: null }
    await expect(charterService.fileApplication(OWNER, proposal, 'target1', ['m1'])).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(charterService.fileApplication(OWNER, proposal, 'target1', ['m1'])).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(settle).not.toHaveBeenCalled()
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(builders.sign.mock.calls[0][2]).toMatchObject({ fund: true })
  })
})
