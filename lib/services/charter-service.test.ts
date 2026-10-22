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
  documents: { delete: vi.fn() },
}))
const builders = vi.hoisted(() => ({ sign: vi.fn(), exists: vi.fn(), consumed: vi.fn() }))
const storage = vi.hoisted(() => {
  const items = new Map<string, string>()
  const local = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
    clear: () => items.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true })
  return local
})
const settle = vi.hoisted(() => vi.fn())
const nonces = vi.hoisted(() => ({ reserve: vi.fn(), release: vi.fn(), next: 1n }))
const locks = vi.hoisted(() => vi.fn())

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('@dashevo/wasm-sdk', () => ({
  PrivateKey: { fromWIF: () => ({ free: () => undefined }) },
  StateTransition: { fromBytes: () => ({}) },
  IdentitySigner: class { addKey() {} free() {} },
  Identifier: { fromBase58: () => ({ toBytes: () => new Uint8Array(32) }) },
}))
vi.mock('@/lib/moderation-charters/transitions.mjs', () => ({
  signCharterCreate: builders.sign,
  charterStepExists: builders.exists,
  charterNonceConsumed: builders.consumed,
  charterIdBytes: () => new Uint8Array(32),
  charterKeyInCreation: () => ({}),
}))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { settleCreate: settle } }))
vi.mock('@/lib/identity-write-lock', () => ({ withIdentityWriteLock: (_o: string, _c: string, write: () => Promise<unknown>) => { locks(); return write() } }))
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
const { CHARTERS_CONTRACT_ID } = await import('@/lib/moderation-charters/rules.mjs')

/** A fresh page (a reload, or another tab) sharing this browser's storage. */
async function anotherTab() {
  vi.resetModules()
  return (await import('./charter-service')).charterService
}

const OWNER = 'owner1'
// Each test files for its own target (its own slot).
let TERMS = { targetContractId: 'target0', description: 'We hide spam.', reasonIds: ['r1'], moderatorsShare: 60, rewardSplit: { leader: 40, equal: 30, actions: 30 } }
let targets = 0
const timeout = () => Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })
const slotKey = (type: string, slot: string) => `yappr:charter-pending:${CHARTERS_CONTRACT_ID}:${OWNER}:${type}:${slot}`
const stored = (type: string, slot: string) => {
  const raw = storage.getItem(slotKey(type, slot))
  return raw === null ? null : JSON.parse(raw) as { signed?: { nonce: string }; reservation?: { id: string }; landed?: string; fingerprint?: string }
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.clear()
  builders.consumed.mockResolvedValue(false)
  nonces.next = 1n
  sdk.identities.fetch.mockResolvedValue({ publicKeys: [] })
  builders.sign.mockImplementation(async (_w: unknown, _sdk: unknown, { type, ownerId, nonce }: { type: string; ownerId: string; nonce: bigint }) => (
    { id: `doc-${nonce}`, type, owner: ownerId, nonce: String(nonce), bytes: new Uint8Array([Number(nonce)]), hash: `h${nonce}` }))
  nonces.reserve.mockImplementation((_o: string, _c: string, nonce: bigint) => ({ id: `r${nonce}`, nonce, expiresAt: null }))
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

  it('reports the proposal filed once it is proved, without signing again, and forgets it', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValueOnce(null).mockResolvedValueOnce('landed')
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), 1n)
    expect(stored('submittedCharter', TERMS.targetContractId)).toMatchObject({ landed: 'doc-1' })
  })

  it('signs anew only once Platform proves the first one dead (nonce spent, document absent)', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
    builders.exists.mockResolvedValue(false)
    settle.mockResolvedValue('not-recorded')
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
})

describe('a refusal', () => {
  it('drops the bytes on a refusal at broadcast, freeing the nonce reservation unspent', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('refused'), { code: 40120 }))
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'refused', code: 40120 })
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), undefined)
    expect(stored('submittedCharter', TERMS.targetContractId)).toBeNull()
  })

  it('counts the nonce spent when Platform refused it at execution (paid)', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 40105 }))
    builders.consumed.mockResolvedValue(true)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'refused', code: 40105 })
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), 1n)
  })
})

describe('storage, the one source of truth', () => {
  it('after a reload, resends the stored bytes instead of signing a second proposal under a new nonce', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    const reloaded = await anotherTab()
    await expect(reloaded.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(sdk.stateTransitions.broadcastAndWait).toHaveBeenCalledTimes(2)
    settle.mockResolvedValue('landed')
    await expect(reloaded.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    expect(stored('submittedCharter', TERMS.targetContractId)).toMatchObject({ landed: 'doc-1' })
  })

  it("never drops another tab's newer create for its own older one (two tabs, one slot)", async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    const tabB = charterService
    const tabA = await anotherTab()
    // B signs nonce 1: uncertain.
    settle.mockResolvedValue(null)
    await expect(tabB.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    // A proves nonce 1 dead, signs nonce 2: uncertain.
    settle.mockResolvedValueOnce('not-recorded')
    await expect(tabA.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(stored('submittedCharter', TERMS.targetContractId)?.signed?.nonce).toBe('2')
    // B tries again: it settles what storage holds (A's nonce 2), resends it, and signs nothing.
    await expect(tabB.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).toHaveBeenCalledTimes(2)
    expect(stored('submittedCharter', TERMS.targetContractId)?.reservation?.id).toBe('r2')
  })

  it('sends nothing when the signed create cannot be stored, and frees its nonce unspent', async () => {
    const save = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    try {
      await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'refused' })
      expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
      expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }))
    } finally {
      save.mockRestore()
    }
  })

  it('treats a stored entry it cannot read as one that may still land, and signs nothing', async () => {
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), '{"signed":')
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), JSON.stringify({ old: 'shape' }))
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).not.toHaveBeenCalled()
  })
})

describe('an uncertain application (0.5 DASH deposit)', () => {
  const proposal = { id: 'p1', leaderId: OWNER, targetContractId: 'target-app', description: '', reasonIds: [], moderatorsShare: 60, rewardSplit: null, createdAt: null }

  it('is never declared dead, even with its nonce spent and the contest read empty, so it is never re-signed', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(false)
    builders.consumed.mockResolvedValue(true)
    const first = charterService.fileApplication(OWNER, proposal, 'target-app', ['m1'])
    await expect(first).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(first).rejects.toThrow('Check the election')
    await expect(charterService.fileApplication(OWNER, proposal, 'target-app', ['m1'])).rejects.toMatchObject({ outcome: 'uncertain' })
    // Another tab, a changed member list: still the first application, never a second deposit.
    const other = await anotherTab()
    await expect(other.fileApplication(OWNER, proposal, 'target-app', ['m1', 'm2'])).rejects.toThrow('may still go through')
    expect(settle).not.toHaveBeenCalled()
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(builders.sign.mock.calls[0][2]).toMatchObject({ fund: true })
    expect(nonces.release).not.toHaveBeenCalled()
  })

  it('is reported filed once the contest shows it', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValueOnce(null).mockResolvedValue(true)
    await expect(charterService.fileApplication(OWNER, proposal, 'target-app', ['m1'])).resolves.toBe('doc-1')
    expect(stored('electedCharter', 'target-app')).toMatchObject({ landed: 'doc-1' })
  })
})

describe('a join request', () => {
  it('builds its encrypted message only when a request is signed, never for a resend', async () => {
    const charterKey = vi.spyOn(charterService, 'charterKey').mockImplementation(async () => new Uint8Array(32).fill(1))
    const build = vi.fn(async () => ({ toObject: () => ({ $id: 'x', encryptedMessage: new Uint8Array([7]) }), free: () => undefined }))
    Object.assign(sdk, { moderationCharters: { buildJoinRequest: build } })
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    try {
      await expect(charterService.requestToJoin(OWNER, 'p1', 'hello')).rejects.toMatchObject({ outcome: 'uncertain' })
      await expect(charterService.requestToJoin(OWNER, 'p1', 'hello')).rejects.toMatchObject({ outcome: 'uncertain' })
      expect(build).toHaveBeenCalledTimes(1)
      expect(builders.sign).toHaveBeenCalledTimes(1)
      // Proved dead: re-signed with its message built again, never with no data.
      settle.mockResolvedValueOnce('not-recorded')
      await expect(charterService.requestToJoin(OWNER, 'p1', 'hello')).rejects.toMatchObject({ outcome: 'uncertain' })
      expect(build).toHaveBeenCalledTimes(2)
      expect(builders.sign).toHaveBeenCalledTimes(2)
      expect(builders.sign.mock.calls[1][2]).toMatchObject({ type: 'joinRequest', data: { encryptedMessage: new Uint8Array([7]) } })
      expect(charterKey).toHaveBeenCalledTimes(2)
    } finally {
      charterKey.mockRestore()
    }
  })
})

describe('the outcome a try reports', () => {
  it("never reports \"wasn't recorded\" for a create another tab settled: only a proof of its own death does", async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    let reads = 0
    builders.exists.mockImplementation(async () => {
      // While this tab polls, another tab proves the create landed and clears the slot; this tab's reads lag.
      if (++reads === 6) storage.removeItem(slotKey('submittedCharter', TERMS.targetContractId))
      return null
    })
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(settle).not.toHaveBeenCalled()
  })

  it("reports \"wasn't recorded\" when this try proved its own create dead", async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(false)
    settle.mockResolvedValue('not-recorded')
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toThrow("wasn't recorded")
  })

  it('reports an earlier version as filed, not the edited one, when the stored create landed with other contents', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    settle.mockResolvedValue('landed')
    await expect(charterService.submitProposal(OWNER, { ...TERMS, description: 'Edited.' })).rejects.toThrow('An earlier version of this was filed')
    expect(stored('submittedCharter', TERMS.targetContractId)).toMatchObject({ landed: 'doc-1', fingerprint: expect.stringContaining('We hide spam.') })
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })

  it('refuses a changed write while the same slot is still being sent in this tab', async () => {
    let finish: () => void = () => undefined
    sdk.stateTransitions.broadcastAndWait.mockImplementation(() => new Promise<void>((done) => { finish = done }))
    builders.exists.mockResolvedValue(true)
    const first = charterService.submitProposal(OWNER, TERMS)
    await expect(charterService.submitProposal(OWNER, { ...TERMS, description: 'Edited.' })).rejects.toThrow('still being sent')
    await vi.waitFor(() => expect(sdk.stateTransitions.broadcastAndWait).toHaveBeenCalled())
    finish()
    await expect(first).resolves.toBe('doc-1')
  })

  it('resends a pending create inside one lock, asking for no key', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    locks.mockClear()
    sdk.identities.fetch.mockClear()
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    // The resend's lock and the final settle's: never a second round of prompts and locks.
    expect(locks).toHaveBeenCalledTimes(2)
    expect(sdk.identities.fetch).not.toHaveBeenCalled()
  })
})

describe('a landed marker', () => {
  it('answers a retry from a tab whose reads still lag once another tab proved the create landed, signing nothing', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    const tabA = charterService
    const tabB = await anotherTab()
    await expect(tabA.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    // B proves P landed.
    settle.mockResolvedValueOnce('landed')
    await expect(tabB.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    // A retries; its reads still prove nothing.
    sdk.stateTransitions.broadcastAndWait.mockClear()
    await expect(tabA.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    await expect(tabA.submitProposal(OWNER, { ...TERMS, description: 'Edited.' })).rejects.toThrow('An earlier version of this was filed')
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
  })

  it('is treated as absent and dropped once 15 minutes old', async () => {
    const marker = { landed: 'doc-old', fingerprint: JSON.stringify(TERMS), at: Date.now() - 16 * 60_000 }
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), JSON.stringify(marker))
    builders.exists.mockResolvedValue(true)
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })

  it('goes with the team change it marks when that change is undone, so the change made again is signed', async () => {
    const seated = { electedCharterId: 'e1', submittedCharterId: 'p1' }
    builders.exists.mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-1')
    await charterService.undoTeamChange(OWNER, 'addedModerator', { documentId: 'doc-1', electedCharterId: 'e1', memberId: 'm1' })
    expect(sdk.documents.delete).toHaveBeenCalledTimes(1)
    expect(stored('addedModerator', 'e1:m1')).toBeNull()
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-2')
    expect(builders.sign).toHaveBeenCalledTimes(2)
  })
})

describe("the leader's way out of an application stuck uncertain", () => {
  const proposal = { id: 'p1', leaderId: OWNER, targetContractId: 'target-stuck', description: '', reasonIds: [], moderatorsShare: 60, rewardSplit: null, createdAt: null }

  it('clears the slot only when asked, keeping the old nonce counted as spent, so a new application can be signed', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(false)
    builders.consumed.mockResolvedValue(true)
    await expect(charterService.fileApplication(OWNER, proposal, 'target-stuck', ['m1'])).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(charterService.hasPendingApplication(OWNER, 'target-stuck')).toBe(true)
    // A different member list stays refused until the leader clears it.
    await expect(charterService.fileApplication(OWNER, proposal, 'target-stuck', ['m1', 'm2'])).rejects.toMatchObject({ outcome: 'uncertain' })
    await charterService.abandonApplication(OWNER, 'target-stuck')
    expect(charterService.hasPendingApplication(OWNER, 'target-stuck')).toBe(false)
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), 1n)
    await expect(charterService.fileApplication(OWNER, proposal, 'target-stuck', ['m1', 'm2'])).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).toHaveBeenCalledTimes(2)
  })

  it('treats an unreadable stored application as pending, and clears it when asked', async () => {
    storage.setItem(slotKey('electedCharter', 'target-stuck'), 'not json')
    expect(charterService.hasPendingApplication(OWNER, 'target-stuck')).toBe(true)
    await charterService.abandonApplication(OWNER, 'target-stuck')
    expect(charterService.hasPendingApplication(OWNER, 'target-stuck')).toBe(false)
  })
})
