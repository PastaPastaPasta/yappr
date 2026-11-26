/**
 * The journaled DPNS registration (DATA-4, DATA-10), with the SDK and the
 * write path faked: the deposit the user approved is the cap the domain
 * carries, a changed deposit is refused before anything is signed, and a
 * registration whose answer was lost is continued from what this browser kept
 * instead of paying another preorder.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CREATE_NOT_RECORDED_ERROR } from '@/lib/error-utils'
import type { CreateReceipt, StateTransitionResult } from './state-transition-service'
import v1Schemas from '@/lib/dpns/fixtures/dpns-contract-documents-v1.json'
import v3Schemas from '@/lib/dpns/fixtures/dpns-contract-documents-v3.json'

const OWNER = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'
const KEY = { wif: 'wif', identityKey: {} as never, appConnect: false }
const DEPOSIT = 10_000_000_000n
const ON_CHAIN_PREORDER = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'

const m = vi.hoisted(() => ({
  fund: null as null | { indexName: string; credits: bigint },
  /** Deposits the next reads answer, before `fund`. */
  fundReads: [] as bigint[],
  balance: 0n,
  contenders: [] as string[],
  nonceConsumed: false,
  /** A preorder carrying the record's salted hash is on chain. */
  preorderOnChain: false,
  preorderQueries: 0,
  /** The DPNS document schemas the network's contract has (v1: protocol 14, v3: protocol 15). */
  schemas: {} as unknown,
  /** v3: the owner's preorder of the name on chain, by its `$createdAt`, at block time `nowMs`. */
  v3Preorder: null as null | { createdAt: bigint },
  nowMs: 10_000_000n,
  createDocument: vi.fn(),
  settleCreate: vi.fn(),
  deleteDocument: vi.fn(),
}))

vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({
    dpns: { isContestedUsername: async () => m.fund !== null },
    documents: {
      query: async () => {
        m.preorderQueries += 1
        return m.preorderOnChain ? [{ $id: 'p' }] : []
      },
      queryWithProof: async () => ({
        data: new Map(m.v3Preorder ? [['p', { id: ON_CHAIN_PREORDER, createdAt: m.v3Preorder.createdAt }]] : [['p', undefined]]),
        metadata: { timeMs: m.nowMs },
      }),
      contestFundToJoin: async () => {
        const next = m.fundReads.shift()
        return next === undefined ? (m.fund ?? undefined) : { indexName: 'parentNameAndLabel', credits: next }
      },
    },
    version: () => (m.schemas === v3Schemas ? 15 : 14),
    contracts: { fetch: async () => ({ toJSON: () => ({ documentSchemas: m.schemas }) }) },
    identities: {
      fetch: async () => ({ balance: m.balance }),
      contractNonceWithProof: async () => ({ data: m.nonceConsumed ? 10n : 0n, metadata: { height: 5 } }),
    },
    voting: {
      contestedResourceVoteStateWithProof: async () => ({
        data: { contenders: m.contenders.map((identityId) => ({ identityId })) },
        metadata: { height: 6 },
      }),
    },
  }),
}))
vi.mock('./document-builder-service', () => ({ documentBuilderService: { buildDocumentForCreate: async () => ({}) } }))
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { createDocument: m.createDocument, settleCreate: m.settleCreate, deleteDocument: m.deleteDocument },
}))
vi.mock('@/lib/document-id', () => ({ identityContractNonceConsumed: (current: bigint, nonce: bigint) => current >= nonce }))
vi.mock('@dashevo/wasm-sdk', () => ({ PlatformVersion: class { constructor(readonly version: number) {} } }))

const { registerDpnsName, quoteDpnsName, DpnsNotSentError, preorderRevealable } = await import('./dpns-registration')
const { getEvoSdk } = await import('./evo-sdk-service')
const { PENDING_WRITE_ERROR } = await import('@/lib/error-utils')
const { ContestFundChangedError, BalanceTooLowError } = await import('@/lib/dpns/registration-quote')
const { loadRegistration, preorderNameHash, preorderOwnerNameHash, registrationsInProgress, saltedDomainHash, saveRegistration } = await import('@/lib/dpns/registration-journal')

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  })
  m.fund = null
  m.fundReads = []
  m.balance = 10n ** 12n
  m.contenders = []
  m.nonceConsumed = false
  m.preorderOnChain = false
  m.preorderQueries = 0
  m.schemas = v1Schemas
  m.v3Preorder = null
  m.createDocument.mockReset()
  m.settleCreate.mockReset()
  m.deleteDocument.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

type Step = 'preorder' | 'domain'
type CreateOptions = { beforeBroadcast?: (receipt?: CreateReceipt) => void; prefundedVotingBalance?: { indexName: string; credits: bigint }; replacesNonce?: bigint }

const receiptFor = (step: Step, nonce: bigint): CreateReceipt => ({
  contractId: 'dpns', documentType: step, ownerId: OWNER, documentId: `${step}-${nonce}`, nonce, transition: new Uint8Array([1, 2, 3]),
})

/** Answers each create, in order: the receipt is kept (beforeBroadcast) before the answer, as the real path does. */
function creates(...answers: Array<'confirmed' | 'unconfirmed' | { refused: string } | { notSent: string }>) {
  let nonce = 0n
  for (const answer of answers) {
    m.createDocument.mockImplementationOnce(async (_contract: string, step: Step, _owner: string, _data: unknown, options: CreateOptions): Promise<StateTransitionResult> => {
      if (typeof answer === 'object' && 'notSent' in answer) return { success: false, error: answer.notSent }
      nonce += 1n
      const receipt = receiptFor(step, nonce)
      options.beforeBroadcast?.(receipt)
      if (answer === 'confirmed') return { success: true, confirmed: true }
      if (answer === 'unconfirmed') return { success: true, confirmed: false, receipt }
      return { success: false, error: answer.refused }
    })
  }
}

const register = (input: { contestFund?: bigint | null; owner?: string | null; durable?: () => Promise<void> } = {}) => registerDpnsName({
  label: 'Alice',
  normalizedLabel: 'a11ce',
  ownerId: OWNER,
  signingKey: KEY,
  contestFund: input.contestFund,
  readOwner: async () => input.owner ?? null,
  durable: input.durable,
})
const stepsSent = () => m.createDocument.mock.calls.map((call) => call[1] as Step)
const optionsOf = (index: number) => m.createDocument.mock.calls[index][4] as CreateOptions
const dataOf = (index: number) => m.createDocument.mock.calls[index][3] as Record<string, unknown>

describe('the preorder hash', () => {
  it('is double SHA-256 of the salt and "<normalizedLabel>.dash", as Drive recomputes it', () => {
    const salt = new Uint8Array(32).map((_, i) => i)
    const once = createHash('sha256').update(Buffer.concat([Buffer.from(salt), Buffer.from('a11ce.dash')])).digest()
    const expected = createHash('sha256').update(once).digest()
    expect(Buffer.from(saltedDomainHash(salt, 'a11ce')).toString('hex')).toBe(expected.toString('hex'))
  })
})

describe('a contested name: the approved deposit is the cap', () => {
  beforeEach(() => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
  })

  it('sends the domain with the approved deposit as its most, revealing the preorder salt', async () => {
    creates('confirmed', 'confirmed')
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(stepsSent()).toEqual(['preorder', 'domain'])
    expect(optionsOf(0).prefundedVotingBalance).toBeUndefined()
    expect(optionsOf(1).prefundedVotingBalance).toEqual({ indexName: 'parentNameAndLabel', credits: DEPOSIT })
    const salt = dataOf(1).preorderSalt as Uint8Array
    expect(dataOf(0).saltedDomainHash).toEqual(saltedDomainHash(salt, 'a11ce'))
    expect(dataOf(1)).toMatchObject({ label: 'Alice', normalizedLabel: 'a11ce', normalizedParentDomainName: 'dash' })
    // Finished: nothing is left to continue.
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })

  it('refuses before the preorder when the deposit changed since the review, or none was approved', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: 2n * DEPOSIT }
    const changed = await register({ contestFund: DEPOSIT }).catch((error: unknown) => error)
    expect(changed).toBeInstanceOf(DpnsNotSentError)
    expect((changed as InstanceType<typeof DpnsNotSentError>).cause).toBeInstanceOf(ContestFundChangedError)
    expect((changed as Error).message).toBe('The vote deposit for Alice.dash changed from 0.1 DASH (about 600¢) to 0.2 DASH (about 1,200¢) since you reviewed it, so nothing more was charged. Review the new amount, then try again.')
    await expect(register({ contestFund: null })).rejects.toThrow(/goes to a community vote with a 0\.2 DASH/)
    expect(m.createDocument).not.toHaveBeenCalled()
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })

  it('refuses the domain when the deposit changes after the preorder, keeps the preorder, and reuses it once approved', async () => {
    creates('confirmed')
    // The preorder lands; then others join and the deposit doubles before the domain is signed.
    m.fundReads = [DEPOSIT, DEPOSIT, 2n * DEPOSIT]
    await expect(register({ contestFund: DEPOSIT })).rejects.toBeInstanceOf(DpnsNotSentError)
    expect(stepsSent()).toEqual(['preorder'])
    expect(loadRegistration(OWNER, 'a11ce')?.preorderLanded).toBe(true)

    // The user approves the new amount: the domain goes out on the kept preorder, nothing paid twice.
    m.fund = { indexName: 'parentNameAndLabel', credits: 2n * DEPOSIT }
    m.createDocument.mockReset()
    creates('confirmed')
    expect(await register({ contestFund: 2n * DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(stepsSent()).toEqual(['domain'])
    expect(optionsOf(0).prefundedVotingBalance?.credits).toBe(2n * DEPOSIT)
  })

  it('refuses before paying anything when the balance misses the deposit and both fees', async () => {
    m.balance = DEPOSIT
    const error = await register({ contestFund: DEPOSIT }).catch((e: unknown) => e)
    expect((error as InstanceType<typeof DpnsNotSentError>).cause).toBeInstanceOf(BalanceTooLowError)
    expect(m.createDocument).not.toHaveBeenCalled()
  })

  it('keeps a contested domain "not recorded" by id pending: only its vote can settle it', async () => {
    creates('confirmed', { refused: CREATE_NOT_RECORDED_ERROR })
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'pending', step: 'domain' })
    expect(loadRegistration(OWNER, 'a11ce')?.domain).toBeDefined()

    // Checking again: the vote lists the owner.
    m.contenders = [OWNER]
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(m.createDocument).toHaveBeenCalledTimes(2)
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })

  it('builds a new domain only once its nonce is spent and the vote, proved at that height, lacks the owner', async () => {
    creates('confirmed', 'unconfirmed')
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'pending', step: 'domain' })
    // Nonce still free and no contender: unknown, so the same bytes are settled and nothing new is built.
    m.settleCreate.mockResolvedValue(null)
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'pending', step: 'domain' })
    expect(m.createDocument).toHaveBeenCalledTimes(2)
    // Spent, and refused: the preorder still stands, so only a domain goes out.
    m.nonceConsumed = true
    creates('confirmed')
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(stepsSent()).toEqual(['preorder', 'domain', 'domain'])
  })
})

describe('resuming a registration whose answer was lost', () => {
  it('continues on the preorder it sent instead of paying another one', async () => {
    creates('unconfirmed')
    expect(await register()).toEqual({ state: 'pending', step: 'preorder' })
    const kept = loadRegistration(OWNER, 'a11ce')
    expect(kept?.preorder?.documentId).toBe('preorder-1')

    // Still unknown: nothing new is sent.
    m.settleCreate.mockResolvedValueOnce(null)
    expect(await register()).toEqual({ state: 'pending', step: 'preorder' })
    expect(m.createDocument).toHaveBeenCalledTimes(1)

    // It landed: the domain follows with the same salt, and no second preorder is paid.
    m.settleCreate.mockResolvedValueOnce('landed')
    creates('confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(m.settleCreate).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'preorder-1' }))
    expect(stepsSent()).toEqual(['preorder', 'domain'])
    expect(dataOf(1).preorderSalt).toEqual(kept?.salt)
  })

  it('calls the name registered when its domain landed though the answer was lost', async () => {
    creates('confirmed', 'unconfirmed')
    expect(await register()).toEqual({ state: 'pending', step: 'domain' })
    // DPNS now shows the name as the owner's: done, nothing more sent or settled.
    expect(await register({ owner: OWNER })).toEqual({ state: 'registered' })
    expect(m.createDocument).toHaveBeenCalledTimes(2)
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })

  it('settles an unconfirmed domain by proof, and rebuilds only one proved never recorded', async () => {
    creates('confirmed', 'unconfirmed')
    await register()
    m.settleCreate.mockResolvedValueOnce('not-recorded')
    creates('confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['preorder', 'domain', 'domain'])
  })

  it('pays a new preorder, on the same salt, only once the first is proved never recorded', async () => {
    creates('unconfirmed')
    await register()
    const salt = loadRegistration(OWNER, 'a11ce')?.salt
    m.settleCreate.mockResolvedValueOnce('not-recorded')
    creates('confirmed', 'confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['preorder', 'preorder', 'domain'])
    expect(optionsOf(1).replacesNonce).toBeUndefined()
    expect(dataOf(2).preorderSalt).toEqual(salt)
  })

  it('replaces a stalled preorder at its own nonce, so at most one of the two can land', async () => {
    creates('unconfirmed')
    await register()
    m.settleCreate.mockResolvedValueOnce('stalled')
    creates('confirmed', 'confirmed')
    await register()
    expect(optionsOf(1).replacesNonce).toBe(1n)
  })

  it('reports pending, sending nothing, when the name cannot be read while a step is out', async () => {
    creates('unconfirmed')
    await register()
    const unreadable = registerDpnsName({ label: 'Alice', normalizedLabel: 'a11ce', ownerId: OWNER, signingKey: KEY, readOwner: async () => { throw new Error('timeout') } })
    expect(await unreadable).toEqual({ state: 'pending', step: 'preorder' })
    expect(m.settleCreate).not.toHaveBeenCalled()
  })

  it('drops a refused step, and sends nothing it could not keep a record of', async () => {
    creates({ refused: 'Insufficient identity balance (code=40500)' })
    await expect(register()).rejects.toThrow(/code=40500/)
    expect(loadRegistration(OWNER, 'a11ce')?.preorder).toBeUndefined()

    store.clear()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => undefined, key: () => null, length: 0 })
    await expect(register()).rejects.toBeInstanceOf(DpnsNotSentError)
    expect(m.createDocument).toHaveBeenCalledTimes(1)
  })

  it('refuses a name someone else holds, and forgets the registration', async () => {
    creates('confirmed', 'unconfirmed')
    await register()
    await expect(register({ owner: 'someone-else' })).rejects.toThrow(/already taken/)
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })
})

describe('a preorder the journal could lose track of (review: must-fix 1)', () => {
  it('keeps a stalled preorder when its replacement is not sent (the deposit changed)', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('unconfirmed')
    await register({ contestFund: DEPOSIT })
    m.settleCreate.mockResolvedValueOnce('stalled')
    m.fund = { indexName: 'parentNameAndLabel', credits: 2n * DEPOSIT }
    await expect(register({ contestFund: DEPOSIT })).rejects.toBeInstanceOf(DpnsNotSentError)
    expect(loadRegistration(OWNER, 'a11ce')?.preorder?.documentId).toBe('preorder-1')
    expect(m.createDocument).toHaveBeenCalledTimes(1)
  })

  it('keeps the stalled preorder, pending, when its nonce was taken before the replacement went out', async () => {
    creates('unconfirmed')
    await register()
    m.settleCreate.mockResolvedValueOnce('stalled')
    creates({ notSent: PENDING_WRITE_ERROR })
    expect(await register()).toEqual({ state: 'pending', step: 'preorder' })
    expect(optionsOf(1).replacesNonce).toBe(1n)
    expect(loadRegistration(OWNER, 'a11ce')?.preorder?.documentId).toBe('preorder-1')
  })

  it('keeps the stalled preorder, pending, when the replacement reads absent at the shared nonce', async () => {
    creates('unconfirmed')
    await register()
    m.settleCreate.mockResolvedValueOnce('stalled')
    creates({ refused: CREATE_NOT_RECORDED_ERROR })
    expect(await register()).toEqual({ state: 'pending', step: 'preorder' })
    expect(loadRegistration(OWNER, 'a11ce')?.preorder?.documentId).toBe('preorder-1')
  })

  it('uses a preorder already on chain for the salt instead of paying another', async () => {
    creates('unconfirmed')
    await register()
    // Proved never recorded by its receipt, yet a preorder with this salted hash is there
    // (a lagging read, or one sent from another tab): never pay a second, refused one.
    m.settleCreate.mockResolvedValueOnce('not-recorded')
    m.preorderOnChain = true
    creates('confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['preorder', 'domain'])
  })

  it('never queries the chain for a brand-new salt, and keeps it durable before the first send', async () => {
    const order: string[] = []
    m.createDocument.mockImplementationOnce(async () => { order.push('send'); return { success: true, confirmed: true } })
    creates('confirmed')
    await register({ durable: async () => { order.push('durable') } })
    expect(order).toEqual(['durable', 'send'])
    expect(m.preorderQueries).toBe(0)
  })

  it('reports pending, not "nothing was sent", when the landed preorder cannot be recorded', async () => {
    let writes = 0
    const setItem = (key: string, value: string) => {
      writes += 1
      // The salt and the receipt are stored; the third write (preorder landed) fails.
      if (writes === 3) throw new Error('quota')
      store.set(key, value)
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem, removeItem: (key: string) => { store.delete(key) }, key: () => null, length: 0 })
    creates('confirmed')
    expect(await register()).toEqual({ state: 'pending', step: 'preorder' })
    expect(loadRegistration(OWNER, 'a11ce')?.preorder).toBeDefined()
  })
})

describe('continuing a registration (review: must-fix 2 and the lows)', () => {
  it('quotes nothing more once a domain was sent', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('confirmed', 'unconfirmed')
    await register({ contestFund: DEPOSIT })
    expect(await quoteDpnsName(await getEvoSdk(), OWNER, 'Alice', 'a11ce')).toEqual({ label: 'Alice', contestFund: null, fees: 0n })
  })

  it('remembers that the domain it sent is contested, and settles it by its vote', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('confirmed', 'unconfirmed')
    await register({ contestFund: DEPOSIT })
    expect(loadRegistration(OWNER, 'a11ce')?.domainContested).toBe(true)
    // The name no longer reads as contested (say, the check changed): the record still decides.
    m.fund = null
    m.contenders = [OWNER]
    expect(await register()).toEqual({ state: 'joined-vote' })
    expect(m.settleCreate).not.toHaveBeenCalled()
  })

  it('says a domain the network turned down for now is stalled, not just pending', async () => {
    creates('confirmed', 'unconfirmed')
    await register()
    m.settleCreate.mockResolvedValueOnce('stalled')
    expect(await register()).toEqual({ state: 'pending', step: 'domain', stalled: true })
  })

  it('lists only registrations something was sent for', () => {
    saveRegistration({ ownerId: OWNER, label: 'Bob', normalizedLabel: 'b0b', salt: new Uint8Array(32) })
    saveRegistration({ ownerId: OWNER, label: 'Alice', normalizedLabel: 'a11ce', salt: new Uint8Array(32), preorderLanded: true })
    expect(registrationsInProgress(OWNER).map((record) => record.label)).toEqual(['Alice'])
  })
})

describe('a contested domain whose receipt was lost (second review)', () => {
  it('sends no second domain when the owner is already a contender, and calls it joined', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    // The preorder landed; the domain went out but the app was killed before its receipt was kept.
    saveRegistration({ ownerId: OWNER, label: 'Alice', normalizedLabel: 'a11ce', salt: new Uint8Array(32), preorderLanded: true })
    m.contenders = [OWNER]
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(m.createDocument).not.toHaveBeenCalled()
    expect(loadRegistration(OWNER, 'a11ce')).toBeNull()
  })

  it('says a re-sent contested domain refused for now is stalled', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('confirmed', 'unconfirmed')
    await register({ contestFund: DEPOSIT })
    m.settleCreate.mockResolvedValueOnce('stalled')
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'pending', step: 'domain', stalled: true })
  })
})

describe('DPNS v3 (protocol 15): preorders by name hash', () => {
  const HOUR_MS = 3_600_000n
  beforeEach(() => {
    m.schemas = v3Schemas
  })

  it('preorders a free name with nameHash and ownerNameHash, and sends no salt with the domain', async () => {
    creates('confirmed', 'confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['preorder', 'domain'])
    const ownerBytes = (await import('bs58')).default.decode(OWNER)
    expect(dataOf(0)).toEqual({ nameHash: preorderNameHash('a11ce'), ownerNameHash: preorderOwnerNameHash(ownerBytes, 'a11ce') })
    expect(dataOf(1)).not.toHaveProperty('preorderSalt')
    expect(dataOf(1)).toMatchObject({ label: 'Alice', normalizedLabel: 'a11ce', parentDomainName: 'dash', normalizedParentDomainName: 'dash' })
    expect(m.preorderQueries).toBe(0)
  })

  it('hashes as Drive declares: sha256d of "<label>.dash", and of the owner id then "<label>.dash"', () => {
    const d = (bytes: Buffer) => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().toString('hex')
    const owner = Buffer.alloc(32, 5)
    expect(Buffer.from(preorderNameHash('a11ce')).toString('hex')).toBe(d(Buffer.from('a11ce.dash')))
    expect(Buffer.from(preorderOwnerNameHash(owner, 'a11ce')).toString('hex')).toBe(d(Buffer.concat([owner, Buffer.from('a11ce.dash')])))
  })

  it('reveals a preorder of the name the owner already holds instead of paying another', async () => {
    m.v3Preorder = { createdAt: m.nowMs - 60_000n }
    creates('confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['domain'])
  })

  it('preorders anew when the one it saw land is gone (expired and cleaned up)', async () => {
    saveRegistration({ ownerId: OWNER, label: 'Alice', normalizedLabel: 'a11ce', salt: new Uint8Array(32), preorderLanded: true, preorderLandedAt: Date.now() - 2 * 3_600_000 })
    creates('confirmed', 'confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['preorder', 'domain'])
  })

  it('reveals a preorder it saw land minutes ago even when a lagging node reads it absent', async () => {
    saveRegistration({ ownerId: OWNER, label: 'Alice', normalizedLabel: 'a11ce', salt: new Uint8Array(32), preorderLanded: true, preorderLandedAt: Date.now() - 120_000 })
    creates('confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(stepsSent()).toEqual(['domain'])
  })

  it('quotes no preorder fee while the owner holds a revealable preorder', async () => {
    m.v3Preorder = { createdAt: m.nowMs - 60_000n }
    const withPreorder = await quoteDpnsName(await getEvoSdk(), OWNER, 'Alice', 'a11ce')
    m.v3Preorder = null
    const fresh = await quoteDpnsName(await getEvoSdk(), OWNER, 'Alice', 'a11ce')
    expect(withPreorder.fees).toBeLessThan(fresh.fees)
  })

  it('deletes an expiring preorder with the DPNS key, then preorders anew', async () => {
    m.v3Preorder = { createdAt: m.nowMs - HOUR_MS + 30_000n }
    m.deleteDocument.mockResolvedValueOnce({ success: true })
    creates('confirmed', 'confirmed')
    expect(await register()).toEqual({ state: 'registered' })
    expect(m.deleteDocument).toHaveBeenCalledWith(expect.any(String), 'preorder', ON_CHAIN_PREORDER, OWNER, undefined, { signingKey: KEY })
    expect(stepsSent()).toEqual(['preorder', 'domain'])
  })

  it('sends nothing more when the expiring preorder could not be deleted', async () => {
    m.v3Preorder = { createdAt: m.nowMs - HOUR_MS }
    m.deleteDocument.mockResolvedValueOnce({ success: false, error: 'refused' })
    await expect(register()).rejects.toThrow('refused')
    expect(m.createDocument).not.toHaveBeenCalled()
  })

  it('caps a contested domain at the approved deposit, and refuses a changed one before anything is paid', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('confirmed', 'confirmed')
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(optionsOf(1).prefundedVotingBalance).toEqual({ indexName: 'parentNameAndLabel', credits: DEPOSIT })

    m.createDocument.mockReset()
    m.fund = { indexName: 'parentNameAndLabel', credits: 2n * DEPOSIT }
    const error = await register({ contestFund: DEPOSIT }).catch((e: unknown) => e)
    expect((error as InstanceType<typeof DpnsNotSentError>).cause).toBeInstanceOf(ContestFundChangedError)
    expect(m.createDocument).not.toHaveBeenCalled()
  })

  it('refuses the domain when the deposit rises after the preorder, then reveals the same preorder once re-approved', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    creates('confirmed')
    m.fundReads = [DEPOSIT, DEPOSIT, 2n * DEPOSIT]
    await expect(register({ contestFund: DEPOSIT })).rejects.toBeInstanceOf(DpnsNotSentError)
    expect(stepsSent()).toEqual(['preorder'])

    m.v3Preorder = { createdAt: m.nowMs - 60_000n }
    m.fund = { indexName: 'parentNameAndLabel', credits: 2n * DEPOSIT }
    m.createDocument.mockReset()
    creates('confirmed')
    expect(await register({ contestFund: 2n * DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(stepsSent()).toEqual(['domain'])
    expect(optionsOf(0).prefundedVotingBalance?.credits).toBe(2n * DEPOSIT)
  })

  it('calls a contested name joined, sending nothing, when its domain already consumed the preorder', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    m.contenders = [OWNER]
    expect(await register({ contestFund: DEPOSIT })).toEqual({ state: 'joined-vote' })
    expect(m.createDocument).not.toHaveBeenCalled()
  })

  it('quotes the deposit and both fees for a fresh contested name', async () => {
    m.fund = { indexName: 'parentNameAndLabel', credits: DEPOSIT }
    const quote = await quoteDpnsName(await getEvoSdk(), OWNER, 'Alice', 'a11ce')
    expect(quote.contestFund).toEqual({ indexName: 'parentNameAndLabel', credits: DEPOSIT })
    expect(quote.fees).toBeGreaterThan(0n)
  })
})

describe('preorderRevealable', () => {
  it('reveals a preorder only while it outlives a broadcast by a minute', () => {
    expect(preorderRevealable(0n, 3600, 3_600_000n - 60_001n)).toBe(true)
    expect(preorderRevealable(0n, 3600, 3_600_000n - 60_000n)).toBe(false)
    expect(preorderRevealable(undefined, 3600, 10n ** 15n)).toBe(true)
    expect(preorderRevealable(0n, null, 10n ** 15n)).toBe(true)
  })
})
