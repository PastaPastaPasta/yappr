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
  identities: { fetch: vi.fn(), update: vi.fn() },
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
const sdkLocks = vi.hoisted(() => vi.fn())
const sdkPreconditions = vi.hoisted(() => [] as Array<(() => Promise<boolean>) | undefined>)
const keys = vi.hoisted(() => ({ match: vi.fn(), stepUp: vi.fn() }))

const hooks = vi.hoisted(() => ({ onSdk: undefined as (() => void) | undefined, onAwaitNonce: undefined as (() => void) | undefined }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => { hooks.onSdk?.(); return sdk } }))
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
vi.mock('@/lib/identity-write-lock', () => ({ withIdentityWriteLock: async (_o: string, _c: string, write: () => Promise<unknown>) => { await locks(); return write() } }))
vi.mock('./identity-nonce', () => ({
  awaitNonce: async () => { hooks.onAwaitNonce?.(); return { current: 0n, value: nonces.next++ } },
  allocateNonce: () => 1n,
  reserveNonce: nonces.reserve,
  releaseNonce: nonces.release,
  WRITE_PRECONDITION_FAILED: 'This was not sent: what it depended on changed.',
  withSdkSignedWrite: async (_o: string, _c: string, write: () => Promise<unknown>, _scope?: string, precondition?: () => Promise<boolean>) => {
    sdkPreconditions.push(precondition)
    await sdkLocks()
    if (precondition && !(await precondition())) throw new Error('This was not sent: what it depended on changed.')
    return write()
  },
}))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: keys.match }))
// The shared step-up: its session lifecycle is real; the sheet's prompt is answered by keys.stepUp.
vi.mock('@/lib/auth/critical-key', async (original: () => Promise<Record<string, unknown>>) => ({
  ...(await original()),
  askForKey: (_identityId: string, prompt: unknown) => keys.stepUp(prompt),
}))
const auth = vi.hoisted(() => ({ identity: 'owner1' as string | null, epoch: 1 }))
vi.mock('@/lib/auth/active-identity', () => ({ currentIdentityId: () => auth.identity }))
vi.mock('@/lib/secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/auth/signing-keys', () => ({ hasAppConnectSession: () => false }))
vi.mock('@/lib/retry-utils', () => ({ sleep: async () => undefined }))

const { charterService } = await import('./charter-service')
const { CHARTERS_CONTRACT_ID } = await import('@/lib/moderation-charters/rules.mjs')
const { CharterActionError } = await import('@/lib/moderation-charters/refusals')
const { bindCriticalKeySession } = await import('@/lib/auth/critical-key')
bindCriticalKeySession(() => auth.epoch)

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
  auth.identity = OWNER
  auth.epoch = 1
  hooks.onSdk = undefined
  hooks.onAwaitNonce = undefined
  keys.match.mockReset().mockReturnValue({ ok: true, key: { keyId: 1 }, match: { keyId: 1 } })
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
  it("keeps an uncertain create when its resend is refused: the refusal speaks for a node now, not for the first send", async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    // Landed, but unreadable; a node behind on the funding refuses the replay.
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(Object.assign(new Error('insufficient balance'), { code: 40120 }))
    builders.consumed.mockResolvedValue(true)
    const refusedResend = charterService.submitProposal(OWNER, TERMS)
    // Uncertain, never "refused": the proposal may have landed; the reason is kept.
    await expect(refusedResend).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(refusedResend).rejects.toThrow('the network refused to resend it just now')
    expect(stored('submittedCharter', TERMS.targetContractId)?.signed?.nonce).toBe('1')
    expect(nonces.release).not.toHaveBeenCalled()
    // Another try resends the same bytes, and signs nothing new.
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(timeout())
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(builders.sign).toHaveBeenCalledTimes(1)
    expect(sdk.stateTransitions.broadcastAndWait).toHaveBeenCalledTimes(3)
  })


  const seatedE5 = { electedCharterId: 'e5', submittedCharterId: 'p1' }

  it('drops the bytes of a unique write on a refusal at broadcast, freeing the nonce reservation unspent', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('refused'), { code: 40120 }))
    await expect(charterService.addMember(OWNER, seatedE5, 'm1')).rejects.toMatchObject({ outcome: 'refused', code: 40120 })
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), undefined)
    expect(stored('addedModerator', 'e5:m1')).toBeNull()
  })

  it('keeps a proposal through a refusal of its first send: the SDK may have retried after a dispatch that landed', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('a cited reason is not visible yet'), { code: 40120 }))
    const first = charterService.submitProposal(OWNER, TERMS)
    await expect(first).rejects.toMatchObject({ outcome: 'uncertain' })
    await expect(first).rejects.toThrow('This may still go through; the network refused it just now')
    expect(stored('submittedCharter', TERMS.targetContractId)?.signed?.nonce).toBe('1')
    expect(nonces.release).not.toHaveBeenCalled()
  })

  it('counts the nonce spent when Platform refused it at execution (paid)', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 40105 }))
    builders.consumed.mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seatedE5, 'm1')).rejects.toMatchObject({ outcome: 'refused', code: 40105 })
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

describe('join requests', () => {
  const doc = (n: number) => ({ toObject: () => ({ $id: `j${n}`, $ownerId: `o${n}` }), id: { toBase58: () => `j${n}` }, free: () => undefined })
  const page = (from: number, count: number) => new Map(Array.from({ length: count }, (_, i) => [`j${from + i}`, doc(from + i)]))

  it('fails as a whole when a later page cannot be read, never returning the first page as the full list', async () => {
    const read = vi.fn().mockResolvedValueOnce(page(0, 100)).mockRejectedValueOnce(new Error('offline'))
    Object.assign(sdk, { moderationCharters: { joinRequests: read } })
    await expect(charterService.joinRequests('p1')).rejects.toThrow('offline')
    expect(read.mock.calls[1][0]).toMatchObject({ startAfter: 'j99' })
  })

  it('fails when the first page cannot be read', async () => {
    Object.assign(sdk, { moderationCharters: { joinRequests: vi.fn().mockRejectedValue(new Error('offline')) } })
    await expect(charterService.joinRequests('p1')).rejects.toThrow('offline')
  })
})

describe('a proposal', () => {
  it('re-checks the seat right before it is signed, signing nothing once a team was seated', async () => {
    const seated = vi.fn(async () => { throw new CharterActionError('Social already has a seated team, so new teams can\'t stand yet.', 'refused') })
    await expect(charterService.submitProposal(OWNER, TERMS, { stillOpen: seated })).rejects.toThrow('already has a seated team')
    expect(seated).toHaveBeenCalledTimes(1)
    expect(builders.sign).not.toHaveBeenCalled()
  })
})

describe('a write queued behind another', () => {
  const proposal = { id: 'p1', leaderId: OWNER, targetContractId: 'target-q', description: '', reasonIds: [], moderatorsShare: 60, rewardSplit: null, createdAt: null }

  it('signs nothing once the session is forgotten while it waited for the lock', async () => {
    let release: () => void = () => undefined
    // The first lock (the slot) is free; the second (the signature) waits on another tab.
    locks.mockImplementationOnce(() => undefined).mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const filing = charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'])
    await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(2))
    charterService.forgetKeys()
    release()
    await expect(filing).rejects.toMatchObject({ outcome: 'cancelled' })
    expect(builders.sign).not.toHaveBeenCalled()
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
    expect(stored('electedCharter', 'target-q')).toBeNull()
  })

  it('re-checks the election after the prompt and the wait, signing nothing once applications have closed', async () => {
    const closed = vi.fn(async () => { throw new CharterActionError('Applications have closed: masternodes are voting.', 'refused') })
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: closed })).rejects.toThrow('Applications have closed')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(builders.sign).not.toHaveBeenCalled()
  })

  it('re-checks after waiting for an earlier transition to settle, so a window that closed meanwhile signs nothing', async () => {
    let closed = false
    hooks.onAwaitNonce = () => { closed = true }
    const eligible = vi.fn(async () => { if (closed) throw new CharterActionError('Applications have closed: masternodes are voting.', 'refused') })
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: eligible })).rejects.toThrow('Applications have closed')
    expect(builders.sign).not.toHaveBeenCalled()
  })

  it('refuses with nothing sent when the re-check cannot read the election', async () => {
    const offline = vi.fn(async () => { throw new Error('Request timed out') })
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: offline })).rejects.toMatchObject({ outcome: 'refused' })
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: offline })).rejects.toThrow('Nothing was sent')
    expect(builders.sign).not.toHaveBeenCalled()
  })

  it('resends an application already signed without re-checking it', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    const open = vi.fn(async () => undefined)
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: open })).rejects.toMatchObject({ outcome: 'uncertain' })
    open.mockRejectedValue(new Error('should not be asked'))
    await expect(charterService.fileApplication(OWNER, proposal, 'target-q', ['m1'], { stillEligible: open })).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })
})

describe('a sign-out (the auth epoch moves on before any cleanup finishes)', () => {
  it('stops a write waiting for the lock, without the page forgetting anything', async () => {
    let release: () => void = () => undefined
    locks.mockImplementationOnce(() => undefined).mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const filing = charterService.submitProposal(OWNER, TERMS)
    await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(2))
    // logoutNow(): the epoch moves at once; the identity is still published until cleanup ends.
    auth.epoch++
    release()
    await expect(filing).rejects.toMatchObject({ outcome: 'cancelled' })
    expect(builders.sign).not.toHaveBeenCalled()
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
  })

  it('stops a write once another account signs in, and never uses a charter key unlocked before', async () => {
    const session = charterService.session()
    auth.identity = 'someone-else'
    await expect(charterService.fileReason(OWNER, { code: 'SPM', label: 'Spam' }, { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    const { holdCharterKey, heldCharterKey } = await import('@/lib/moderation-charters/charter-keys')
    holdCharterKey(OWNER, 'leader', new Uint8Array(32).fill(9))
    expect(heldCharterKey(OWNER, 'leader')).not.toBeNull()
    auth.epoch++
    expect(heldCharterKey(OWNER, 'leader')).toBeNull()
    expect(builders.sign).not.toHaveBeenCalled()
  })
})

describe('a session forgotten mid-write', () => {
  it('signs no application whose action began in a session that ended during its first reads', async () => {
    const proposal = { id: 'p1', leaderId: OWNER, targetContractId: 'target-s', description: '', reasonIds: [], moderatorsShare: 60, rewardSplit: null, createdAt: null }
    // The page captured its session, then the leader left while the election was being read.
    const session = charterService.session()
    charterService.forgetKeys()
    await expect(charterService.fileApplication(OWNER, proposal, 'target-s', ['m1'], { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    await expect(charterService.requestToJoin(OWNER, 'p1', 'hello', { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    expect(builders.sign).not.toHaveBeenCalled()
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
  })

  it('hands back no decrypted join message once the leader session ends during decryption', async () => {
    const charterKey = vi.spyOn(charterService, 'charterKey').mockImplementation(async () => new Uint8Array(32).fill(1))
    const doc = { id: { toBase58: () => 'j1' }, ownerId: { toBase58: () => 'o1' }, toObject: () => ({ senderKeyId: 3 }), free: () => undefined }
    Object.assign(sdk, {
      contracts: { fetch: async () => ({ free: () => undefined }) },
      moderationCharters: { joinRequests: async () => new Map([['j1', doc]]) },
      encryptedFor: { decrypt: async () => { charterService.forgetKeys(); return new TextEncoder().encode('secret plan') } },
    })
    sdk.identities.fetch.mockResolvedValue({ publicKeys: [], getPublicKeyById: () => ({}) })
    try {
      const session = charterService.session()
      await expect(charterService.readJoinMessages('p1', OWNER, { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    } finally {
      charterKey.mockRestore()
    }
  })

  it('settles proof-only once the session is forgotten during the existence read', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    // While the session lasts, settling may re-send.
    const [, live] = settle.mock.calls[0] as [unknown, { mayResend: () => boolean }]
    expect(live.mayResend()).toBe(true)
    sdk.stateTransitions.broadcastAndWait.mockClear()
    settle.mockClear()
    builders.exists.mockImplementationOnce(async () => { charterService.forgetKeys(); return null })
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'cancelled' })
    const [, options] = settle.mock.calls[0] as [unknown, { mayResend: () => boolean }]
    expect(options.mayResend()).toBe(false)
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
  })

  it('refuses the later writes of an action begun in a session since forgotten', async () => {
    builders.exists.mockResolvedValue(true)
    const session = charterService.session()
    await expect(charterService.fileReason(OWNER, { code: 'SPM', label: 'Spam' }, { session })).resolves.toBe('doc-1')
    // The page is left after the first reason landed, before the rest of the submission started.
    charterService.forgetKeys()
    await expect(charterService.fileReason(OWNER, { code: 'HAR', label: 'Harassment' }, { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    await expect(charterService.submitProposal(OWNER, TERMS, { session })).rejects.toMatchObject({ outcome: 'cancelled' })
    await expect(charterService.charterKey(OWNER, 'leader', { create: true, session })).rejects.toMatchObject({ outcome: 'cancelled' })
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })

  it('broadcasts no stored create that was waiting for the lock', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    sdk.stateTransitions.broadcastAndWait.mockClear()
    settle.mockClear()
    locks.mockClear()
    let release: () => void = () => undefined
    locks.mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const retry = charterService.submitProposal(OWNER, TERMS)
    await vi.waitFor(() => expect(locks).toHaveBeenCalled())
    charterService.forgetKeys()
    release()
    await expect(retry).rejects.toMatchObject({ outcome: 'cancelled' })
    // Settling may rebroadcast the stored bytes: it is not even started.
    expect(settle).not.toHaveBeenCalled()
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
    expect(stored('submittedCharter', TERMS.targetContractId)?.signed?.nonce).toBe('1')
  })

  it('adds no charter key once the session is forgotten during the SDK setup', async () => {
    sdk.identities.fetch.mockResolvedValue({ publicKeys: [] })
    keys.stepUp.mockImplementationOnce(async () => {
      // Forgotten after the prompt was answered, while the key update is being prepared.
      hooks.onSdk = () => { hooks.onSdk = undefined; charterService.forgetKeys() }
      return Buffer.from(new Uint8Array(32).fill(5)).toString('hex')
    })
    await expect(charterService.charterKey(OWNER, 'member', { create: true })).rejects.toMatchObject({ outcome: 'cancelled' })
    expect(sdk.identities.update).not.toHaveBeenCalled()
  })

  it('signs no queued team-change delete, and keeps its marker', async () => {
    const seated = { electedCharterId: 'e2', submittedCharterId: 'p1' }
    builders.exists.mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-1')
    let release: () => void = () => undefined
    sdkLocks.mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const undoing = charterService.undoTeamChange(OWNER, 'addedModerator', { documentId: 'doc-1', electedCharterId: 'e2', memberId: 'm1' })
    await vi.waitFor(() => expect(sdkLocks).toHaveBeenCalled())
    const precondition = sdkPreconditions[sdkPreconditions.length - 1]
    await expect(precondition?.()).resolves.toBe(true)
    charterService.forgetKeys()
    await expect(precondition?.()).resolves.toBe(false)
    release()
    // Declined by the coordinator's precondition, before any nonce is reserved.
    await expect(undoing).rejects.toMatchObject({ outcome: 'cancelled', message: 'Nothing was sent.' })
    expect(sdk.documents.delete).not.toHaveBeenCalled()
    expect(stored('addedModerator', 'e2:m1')).toMatchObject({ landed: 'doc-1' })
  })
})

describe('the charter key', () => {
  const secp = async () => import('@noble/secp256k1')
  const leaderKeyOnChain = (data: Uint8Array) => ({
    keyId: 7, purpose: 'DECRYPTION', securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1', data,
    contractBounds: { toJSON: () => ({ $type: 'documentType', id: CHARTERS_CONTRACT_ID, documentTypeName: 'submittedCharter' }) },
  })

  it('unlocks from the MASTER key that made it after that key was rotated out, and not from its replacement', async () => {
    const { getPublicKey } = await secp()
    const { deriveCharterKey } = await import('@/lib/moderation-charters/charter-keys')
    const original = new Uint8Array(32).fill(3)
    const charter = deriveCharterKey(original, OWNER, 'leader')
    sdk.identities.fetch.mockResolvedValue({ publicKeys: [leaderKeyOnChain(getPublicKey(charter, true))] })
    // The original MASTER is disabled: it no longer matches an enabled key.
    keys.match.mockReturnValue({ ok: false, reason: 'not-found' })
    const originalHex = Buffer.from(original).toString('hex')
    const replacementHex = Buffer.from(new Uint8Array(32).fill(4)).toString('hex')
    keys.stepUp.mockImplementationOnce(async ({ check }: { check: (typed: string) => Promise<string | null> }) => {
      await expect(check(originalHex)).resolves.toBeNull()
      return originalHex
    })
    await expect(charterService.charterKey(OWNER, 'leader', { create: false })).resolves.toEqual(charter)
    charterService.forgetKeys()
    // The enabled replacement MASTER made no charter key: the prompt says which MASTER key to use.
    keys.match.mockReturnValue({ ok: true, key: { keyId: 9 }, match: { keyId: 9 } })
    keys.stepUp.mockImplementationOnce(async ({ check }: { check: (typed: string) => Promise<string | null> }) => {
      await expect(check(replacementHex)).resolves.toContain('a replaced one still works')
      return replacementHex
    })
    await expect(charterService.charterKey(OWNER, 'leader', { create: false })).rejects.toThrow("doesn't fit")
  })
})

describe('an edited join message', () => {
  it('is refused while the first request may still land, never sent as the first one', async () => {
    const charterKey = vi.spyOn(charterService, 'charterKey').mockImplementation(async () => new Uint8Array(32).fill(1))
    const build = vi.fn(async () => ({ toObject: () => ({ encryptedMessage: new Uint8Array([7]) }), free: () => undefined }))
    Object.assign(sdk, { moderationCharters: { buildJoinRequest: build } })
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    try {
      await expect(charterService.requestToJoin(OWNER, 'p-edit', 'hello')).rejects.toMatchObject({ outcome: 'uncertain' })
      sdk.stateTransitions.broadcastAndWait.mockClear()
      await expect(charterService.requestToJoin(OWNER, 'p-edit', 'hello, edited')).rejects.toThrow('may still go through')
      expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled()
      expect(build).toHaveBeenCalledTimes(1)
      expect(storage.getItem(slotKey('joinRequest', 'p-edit'))).not.toContain('hello')
    } finally {
      charterKey.mockRestore()
    }
  })
})

describe('a landed marker', () => {
  it('for a team change, answers even while recent only on proof, so a change undone elsewhere is made again', async () => {
    const seated = { electedCharterId: 'e7', submittedCharterId: 'p1' }
    builders.exists.mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-1')
    // Taken off from another browser: the recent marker is not trusted.
    builders.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-2')
    expect(builders.sign).toHaveBeenCalledTimes(2)
  })

  it('keeps the signed entry when the marker cannot be stored, so a retry proves it again instead of signing', async () => {
    builders.exists.mockResolvedValue(true)
    const realSet = storage.setItem
    const save = vi.spyOn(storage, 'setItem').mockImplementation((key: string, value: string) => {
      if (value.includes('"landed"')) throw new Error('QuotaExceededError')
      realSet(key, value)
    })
    try {
      await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
      expect(stored('submittedCharter', TERMS.targetContractId)?.signed?.nonce).toBe('1')
      await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-1')
      expect(builders.sign).toHaveBeenCalledTimes(1)
    } finally {
      save.mockRestore()
    }
  })

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

  it('once older than 15 minutes still answers the same proposal, even when a (possibly stale) read finds nothing', async () => {
    const same = JSON.stringify({ ...TERMS, reasonIds: [...TERMS.reasonIds] })
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), JSON.stringify({ landed: 'doc-old', fingerprint: same, at: Date.now() - 16 * 60_000 }))
    builders.exists.mockResolvedValue(false)
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-old')
    expect(builders.sign).not.toHaveBeenCalled()
    expect(builders.exists).not.toHaveBeenCalled()
  })

  it('once older than 15 minutes answers a deletable team change only on proof that it is still there', async () => {
    const seated = { electedCharterId: 'e9', submittedCharterId: 'p1' }
    storage.setItem(slotKey('addedModerator', 'e9:m1'), JSON.stringify({ landed: 'doc-old', fingerprint: 'e9:m1', at: Date.now() - 16 * 60_000 }))
    builders.exists.mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-old')
    expect(builders.exists).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: 'doc-old', type: 'addedModerator', owner: OWNER }), expect.anything())
    // A read that fails proves nothing: refused, nothing signed.
    builders.exists.mockRejectedValueOnce(new Error('Quorum not found in cache'))
    await expect(charterService.addMember(OWNER, seated, 'm1')).rejects.toMatchObject({ outcome: 'refused' })
    // Proved gone (taken off from another device): signed anew.
    builders.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
    await expect(charterService.addMember(OWNER, seated, 'm1')).resolves.toBe('doc-1')
    expect(builders.sign).toHaveBeenCalledTimes(1)
  })

  it('stays for its own retry when a different write that would replace it is refused', async () => {
    const same = JSON.stringify({ ...TERMS, reasonIds: [...TERMS.reasonIds] })
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), JSON.stringify({ landed: 'doc-old', fingerprint: same, at: Date.now() - 16 * 60_000 }))
    // Edited terms, refused right before signing: nothing signed, the marker kept.
    const closed = vi.fn(async () => { throw new CharterActionError('Social already has a seated team.', 'refused') })
    await expect(charterService.submitProposal(OWNER, { ...TERMS, description: 'Edited.' }, { stillOpen: closed })).rejects.toMatchObject({ outcome: 'refused' })
    expect(stored('submittedCharter', TERMS.targetContractId)).toMatchObject({ landed: 'doc-old' })
    // The original terms again: answered from the marker, never a second proposal.
    builders.exists.mockResolvedValue(true)
    await expect(charterService.submitProposal(OWNER, TERMS)).resolves.toBe('doc-old')
    expect(builders.sign).not.toHaveBeenCalled()
  })

  it('once older than 15 minutes gives way to a different write', async () => {
    storage.setItem(slotKey('submittedCharter', TERMS.targetContractId), JSON.stringify({ landed: 'doc-old', fingerprint: 'other terms', at: Date.now() - 16 * 60_000 }))
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

describe('a refused resend of a unique write', () => {
  it('drops a join request whose resend is refused: a second one would be refused as a duplicate', async () => {
    const charterKey = vi.spyOn(charterService, 'charterKey').mockImplementation(async () => new Uint8Array(32).fill(1))
    Object.assign(sdk, { moderationCharters: { buildJoinRequest: vi.fn(async () => ({ toObject: () => ({ encryptedMessage: new Uint8Array([7]) }), free: () => undefined })) } })
    sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    try {
      await expect(charterService.requestToJoin(OWNER, 'p-u', 'hello')).rejects.toMatchObject({ outcome: 'uncertain' })
      sdk.stateTransitions.broadcastAndWait.mockRejectedValueOnce(Object.assign(new Error('bad key'), { code: 40120 }))
      await expect(charterService.requestToJoin(OWNER, 'p-u', 'hello')).rejects.toMatchObject({ outcome: 'refused' })
      expect(stored('joinRequest', 'p-u')).toBeNull()
    } finally {
      charterKey.mockRestore()
    }
  })
})

describe("the leader's way out of a proposal stuck uncertain", () => {
  it('clears the slot only when asked, keeping the old nonce counted as spent, so a new proposal can be signed', async () => {
    sdk.stateTransitions.broadcastAndWait.mockRejectedValue(timeout())
    builders.exists.mockResolvedValue(null)
    settle.mockResolvedValue(null)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
    expect(charterService.hasPendingProposal(OWNER, TERMS.targetContractId)).toBe(true)
    await charterService.abandonProposal(OWNER, TERMS.targetContractId)
    expect(charterService.hasPendingProposal(OWNER, TERMS.targetContractId)).toBe(false)
    expect(nonces.release).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ id: 'r1' }), 1n)
    await expect(charterService.submitProposal(OWNER, TERMS)).rejects.toMatchObject({ outcome: 'uncertain' })
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
