import bs58 from 'bs58'
import { describe, expect, it, vi } from 'vitest'
import { cleanTestContent } from '../scripts/test-content-cleanup.mjs'
import v10 from '../contracts/yappr-social-contract-v10.json'
import v16 from '../contracts/yappr-social-contract-v16.json'

// The orchestration half of the test-content cleanup (cleanTestContent in
// scripts/test-content-cleanup.mjs) against an in-memory SDK: what it lists, what it
// broadcasts, how it decides a tombstone landed, and when it stops. The pure half lives in
// test-content-cleanup.test.ts. Only the wasm-backed pieces are faked (the document builder
// and Identifier); the fake chain applies a replace the way the platform would (the revision
// must be the stored one plus one), so a run that re-broadcast without re-reading would fail.

vi.mock('../scripts/verify-lib.mjs', async (importOriginal) => {
  const bs58 = (await import('bs58')).default
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    buildDocument: ({ contractId, docType, ownerId, data, revision, id }: { contractId: string; docType: string; ownerId: string; data: Record<string, unknown>; revision: bigint; id: Uint8Array }) => ({
      document: { contractId, type: docType, ownerId, id: bs58.encode(id), revision, data },
    }),
  }
})

vi.mock('@dashevo/evo-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Identifier: class {
    constructor(readonly id: string) {}
  },
}))

type Row = Record<string, unknown>
type Clause = [string, string, unknown]
interface QueryArgs { documentTypeName: string; where: Clause[]; orderBy: unknown; limit: number; startAfter?: string }
interface FakeDocument { contractId: string; type: string; ownerId: string; id: string; revision: bigint; data: Row }
interface ReplaceCall { document: FakeDocument; identityKey: unknown; signer: unknown }

const bytes = (fill: number) => new Uint8Array(32).fill(fill)
const b58 = (fill: number) => bs58.encode(bytes(fill))
/** A distinct document id per number (the number in the last four bytes). */
const docId = (n: number) => {
  const raw = new Uint8Array(32).fill(7)
  new DataView(raw.buffer).setUint32(28, n)
  return bs58.encode(raw)
}

const CONTRACT_ID = b58(1)
const CONTRACT_OWNER = b58(2)
const MAKER = b58(3)
const CREDITS_PER_TOMBSTONE = 50
const T0 = 1_700_000_000_000

/** A battery bot as its battery hands it over: a ready key and signer, so no WIF is derived. */
const bot = (fill: number, label = `bot${fill}`) => ({ id: b58(fill), label, identityKey: { keyOf: label }, signer: { signerOf: label } })

const post = (n: number, owner: string, createdAt: number, extra: Row = {}): Row =>
  ({ $id: docId(n), $ownerId: owner, $createdAt: createdAt, $revision: 1, content: `post ${n}`, live: true, tags: ['battery'], ...extra })
const reply = (n: number, owner: string, createdAt: number, extra: Row = {}): Row =>
  ({ $id: docId(n), $ownerId: owner, $createdAt: createdAt, $revision: 1, content: `reply ${n}`, rootPostId: b58(40), ...extra })

const matches = (row: Row, where: Clause[]) => where.every(([field, op, value]) => {
  const actual = row[field]
  if (op === '==') return actual === value
  if (op === '>=') return Number(actual) >= Number(value)
  if (op === '<=') return Number(actual) <= Number(value)
  if (op === 'Between') return Number(actual) >= Number((value as number[])[0]) && Number(actual) <= Number((value as number[])[1])
  throw new Error(`the fake chain does not know the operator ${op}`)
})

interface ChainOptions {
  /** The contract's owner on chain; null when the contract is not registered. */
  contractOwner?: string | null
}

/**
 * An in-memory chain behind the four SDK surfaces the cleanup uses. Rows are kept newest first,
 * as the owner indexes return them. The hooks default to the honest behavior; a test replaces one
 * to inject a fault.
 */
function createChain({ contractOwner = CONTRACT_OWNER }: ChainOptions = {}) {
  const rows: { post: Row[]; reply: Row[] } = { post: [], reply: [] }
  let balance = 1_000_000
  let broadcasts = 0
  const typeRows = (type: string) => rows[type as 'post' | 'reply']
  const find = (type: string, id: string) => typeRows(type).find((row) => row.$id === id) ?? null

  const chain = {
    rows,
    /** Lands a replace, as consensus would: the next revision only. */
    apply(call: ReplaceCall) {
      const list = typeRows(call.document.type)
      const index = list.findIndex((row) => row.$id === call.document.id)
      const old = list[index]
      if (BigInt(old.$revision as number | bigint) + 1n !== call.document.revision) throw new Error('{"code":40106}')
      list[index] = { $id: old.$id, $ownerId: old.$ownerId, $createdAt: old.$createdAt, $revision: call.document.revision, ...call.document.data }
      balance -= CREDITS_PER_TOMBSTONE
    },
    find,
    onReplace: (call: ReplaceCall, _ordinal: number): Promise<void> | void => chain.apply(call),
    onGet: (type: string, id: string): Row | null => find(type, id),
    onQuery: (_args: QueryArgs): void => undefined,
    sdk: {
      contracts: { fetch: vi.fn(async (_id: string) => (contractOwner === null ? null : { ownerId: contractOwner })) },
      documents: {
        query: vi.fn(async (args: QueryArgs) => {
          chain.onQuery(args)
          let list = typeRows(args.documentTypeName).filter((row) => matches(row, args.where))
          if (args.startAfter) list = list.slice(list.findIndex((row) => row.$id === args.startAfter) + 1)
          return { values: () => list.slice(0, args.limit) }
        }),
        get: vi.fn(async (_contractId: string, type: string, id: string) => chain.onGet(type, id)),
        replace: vi.fn(async (call: ReplaceCall) => chain.onReplace(call, ++broadcasts)),
      },
      identities: { balance: vi.fn(async (_id: string) => balance) },
      wasm: { refreshIdentityNonce: vi.fn(async (_id: unknown) => undefined) },
    },
  }
  return chain
}
type Chain = ReturnType<typeof createChain>

/** cleanTestContent's answer; the script is untyped JS, which infers its rows as never[]. */
interface CleanupRow {
  id: string
  label: string
  posts: number
  replies: number
  tombstoned?: number
  failed?: number
  errors?: string[]
  truncated?: boolean
  resume?: Record<string, { until: number; after: string }>
  documents?: { type: string; id: string; createdAt: string | null }[]
}
interface CleanupSummary { mode: string; found: number; tombstoned: number; failed: number; incomplete: number; spentCredits: bigint; identities: CleanupRow[] }

const run = async (chain: Chain, identities: object[], options: Record<string, unknown> = {}) =>
  await cleanTestContent({ sdk: chain.sdk, contractId: CONTRACT_ID, contract: v16, identities, reconnect: undefined, settleMs: 0, log: () => undefined, ...options }) as unknown as CleanupSummary

const replaced = (chain: Chain) => chain.sdk.documents.replace.mock.calls.map(([call]) => call)
const queriesOf = (chain: Chain, type: string) => chain.sdk.documents.query.mock.calls.map(([args]) => args).filter((args) => args.documentTypeName === type)
const ownerOfClause = (args: QueryArgs) => args.where.find(([field]) => field === '$ownerId')?.[2]

describe('a plan run', () => {
  it('lists the live posts and replies, skips tombstones, and writes nothing', async () => {
    const chain = createChain()
    const a = bot(10)
    chain.rows.post.push(post(1, a.id, T0 + 5), post(2, a.id, T0 + 4, { live: undefined, deleted: true, content: undefined }), post(3, a.id, T0 + 1), post(90, b58(11), T0 + 3))
    chain.rows.reply.push(reply(4, a.id, T0 + 6), reply(5, a.id, T0 + 3, { deleted: true }), reply(6, a.id, T0 + 2), reply(91, b58(11), T0 + 2))

    const summary = await run(chain, [a])

    expect(summary).toMatchObject({ mode: 'plan', found: 4, tombstoned: 0, failed: 0, incomplete: 0, spentCredits: 0n })
    expect(summary.identities).toEqual([{
      id: a.id,
      label: 'bot10',
      posts: 2,
      replies: 2,
      documents: [
        { type: 'post', id: docId(1), createdAt: new Date(T0 + 5).toISOString() },
        { type: 'post', id: docId(3), createdAt: new Date(T0 + 1).toISOString() },
        { type: 'reply', id: docId(4), createdAt: new Date(T0 + 6).toISOString() },
        { type: 'reply', id: docId(6), createdAt: new Date(T0 + 2).toISOString() },
      ],
    }])
    expect(chain.sdk.documents.replace).not.toHaveBeenCalled()
    expect(chain.sdk.documents.get).not.toHaveBeenCalled()
    expect(chain.sdk.identities.balance).not.toHaveBeenCalled()
    expect(chain.sdk.wasm.refreshIdentityNonce).not.toHaveBeenCalled()
    // One owner-index read per type, a full page asked for, nothing to continue after.
    expect(queriesOf(chain, 'post')).toHaveLength(1)
    expect(queriesOf(chain, 'reply')).toHaveLength(1)
    expect(queriesOf(chain, 'post')[0]).toMatchObject({ limit: 100 })
    expect(queriesOf(chain, 'post')[0]).not.toHaveProperty('startAfter')
  })
})

describe('a live run', () => {
  it('replaces every target with its tombstone, confirmed by reading it back, and then finds nothing left', async () => {
    const chain = createChain()
    const a = bot(10)
    chain.rows.post.push(post(1, a.id, T0 + 5), post(2, a.id, T0 + 1))
    chain.rows.reply.push(reply(3, a.id, T0 + 6), reply(4, a.id, T0 + 2, { deleted: true }), reply(5, a.id, T0 + 3))

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ mode: 'live', found: 4, tombstoned: 4, failed: 0, incomplete: 0, spentCredits: BigInt(4 * CREDITS_PER_TOMBSTONE) })
    expect(summary.identities).toEqual([{ id: a.id, label: 'bot10', posts: 2, replies: 2, tombstoned: 4, failed: 0, spentCredits: BigInt(4 * CREDITS_PER_TOMBSTONE) }])
    expect(replaced(chain).map(({ document }) => [document.type, document.id])).toEqual([['post', docId(1)], ['post', docId(2)], ['reply', docId(3)], ['reply', docId(5)]])
    for (const call of replaced(chain)) {
      expect(call.identityKey).toBe(a.identityKey)
      expect(call.signer).toBe(a.signer)
      expect(call.document).toMatchObject({ contractId: CONTRACT_ID, ownerId: a.id, revision: 2n })
    }
    // The tombstone shape: the frozen fields only (a post's tags, a reply's root as bytes).
    expect(replaced(chain)[0].document.data).toEqual({ deleted: true, tags: ['battery'] })
    expect(replaced(chain)[2].document.data).toEqual({ deleted: true, rootPostId: bytes(40) })
    // Confirmed by reading each document back.
    expect(chain.sdk.documents.get.mock.calls.map(([, type, id]) => `${type}:${id}`)).toEqual(['post:' + docId(1), 'post:' + docId(2), 'reply:' + docId(3), 'reply:' + docId(5)])
    for (const row of [...chain.rows.post, ...chain.rows.reply]) {
      // The reply that was already a tombstone was left as it was (revision 1).
      expect(row).toMatchObject({ deleted: true, $revision: row.$id === docId(4) ? 1 : 2n })
    }

    const again = await run(chain, [a], { live: true })
    expect(again).toMatchObject({ found: 0, tombstoned: 0, failed: 0, incomplete: 0 })
    expect(replaced(chain)).toHaveLength(4)
  })

  it('counts a document as tombstoned when the broadcast errors but the read-back shows it landed, without broadcasting again', async () => {
    const chain = createChain()
    const a = bot(10)
    chain.rows.post.push(post(1, a.id, T0))
    chain.onReplace = (call) => {
      chain.apply(call)
      throw new Error('transport error: 504 gateway timeout waiting for the state transition result')
    }

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ found: 1, tombstoned: 1, failed: 0, incomplete: 0 })
    expect(replaced(chain)).toHaveLength(1)
    expect(chain.sdk.wasm.refreshIdentityNonce).not.toHaveBeenCalled()
    expect(summary.identities[0]).not.toHaveProperty('errors')
  })

  it('refreshes the nonce, re-reads the document and broadcasts again after a stale nonce (40204)', async () => {
    const chain = createChain()
    const a = bot(10)
    const stored = post(1, a.id, T0)
    chain.rows.post.push(stored)
    chain.onReplace = (call, ordinal) => {
      if (ordinal > 1) return chain.apply(call)
      // The first broadcast is refused, and somebody else revised the document meanwhile.
      stored.$revision = 2
      throw new Error('{"code":40204}')
    }

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ found: 1, tombstoned: 1, failed: 0, incomplete: 0 })
    expect(replaced(chain).map(({ document }) => document.revision)).toEqual([2n, 3n])
    expect(chain.sdk.wasm.refreshIdentityNonce).toHaveBeenCalledTimes(1)
    expect(chain.sdk.wasm.refreshIdentityNonce).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }))
    expect(chain.find('post', docId(1))).toMatchObject({ deleted: true, $revision: 3n })
  })

  it('fails a document at once on a consensus refusal (40127), with no retry, and carries on with the next', async () => {
    const chain = createChain()
    const a = bot(10)
    chain.rows.post.push(post(1, a.id, T0 + 1), post(2, a.id, T0))
    chain.onReplace = (call) => {
      if (call.document.id === docId(1)) throw new Error('{"code":40127}')
      chain.apply(call)
    }

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ found: 2, tombstoned: 1, failed: 1, incomplete: 0 })
    expect(replaced(chain).map(({ document }) => document.id)).toEqual([docId(1), docId(2)])
    expect(chain.sdk.wasm.refreshIdentityNonce).not.toHaveBeenCalled()
    expect(summary.identities[0].errors).toEqual([expect.stringMatching(new RegExp(`^post ${docId(1)}: .*40127`))])
    expect(chain.find('post', docId(1))).not.toHaveProperty('deleted')
  })

  it('fails a document whose confirmation read keeps failing, and gives the identity up after three in a row', async () => {
    const chain = createChain()
    const a = bot(10)
    for (let n = 1; n <= 5; n++) chain.rows.post.push(post(n, a.id, T0 - n))
    chain.onReplace = () => undefined
    chain.onGet = () => {
      throw new Error('request timed out')
    }

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ found: 5, tombstoned: 0, failed: 5, incomplete: 0 })
    // Three broadcasts, then the other two are not even tried.
    expect(replaced(chain).map(({ document }) => document.id)).toEqual([docId(1), docId(2), docId(3)])
    const errors = summary.identities[0].errors as string[]
    expect(errors).toHaveLength(4)
    expect(errors.slice(0, 3).every((error, i) => error.startsWith(`post ${docId(i + 1)}: `) && /timed out/.test(error))).toBe(true)
    expect(errors[3]).toBe('gave up after 3 failures in a row; 2 left live')
  })

  it('starts counting failures over after a success', async () => {
    const chain = createChain()
    const a = bot(10)
    for (let n = 1; n <= 4; n++) chain.rows.post.push(post(n, a.id, T0 - n))
    const failing = new Set([docId(1), docId(2), docId(4)])
    chain.onGet = (type, id) => {
      if (failing.has(id)) throw new Error('request timed out')
      return chain.find(type, id)
    }

    const summary = await run(chain, [a], { live: true })

    expect(summary).toMatchObject({ found: 4, tombstoned: 1, failed: 3 })
    expect(replaced(chain)).toHaveLength(4)
    expect((summary.identities[0].errors as string[]).some((error) => /gave up/.test(error))).toBe(false)
  })
})

describe('one identity failing', () => {
  it('does not stop the next identity from being cleaned (a confirmation that keeps failing)', async () => {
    const chain = createChain()
    const a = bot(10)
    const b = bot(11)
    for (let n = 1; n <= 4; n++) chain.rows.post.push(post(n, a.id, T0 - n))
    chain.rows.post.push(post(20, b.id, T0), post(21, b.id, T0 - 1))
    chain.onGet = (type, id) => {
      if (chain.find(type, id)?.$ownerId === a.id) throw new Error('request timed out')
      return chain.find(type, id)
    }

    const summary = await run(chain, [a, b], { live: true })

    expect(summary).toMatchObject({ found: 6, tombstoned: 2, failed: 4, incomplete: 0 })
    expect(summary.identities.map(({ label, tombstoned, failed }) => [label, tombstoned, failed])).toEqual([['bot10', 0, 4], ['bot11', 2, 0]])
    expect(chain.find('post', docId(20))).toMatchObject({ deleted: true })
    expect(chain.find('post', docId(21))).toMatchObject({ deleted: true })
  })

  it('does not stop the next identity when its documents cannot be read, and marks that one incomplete', async () => {
    const chain = createChain()
    const a = bot(10)
    const b = bot(11)
    chain.rows.post.push(post(1, a.id, T0), post(20, b.id, T0))
    chain.onQuery = (args) => {
      if (ownerOfClause(args) === a.id) throw new Error('invalid argument: where clause on non indexed property')
    }

    const summary = await run(chain, [a, b], { live: true })

    expect(summary).toMatchObject({ found: 1, tombstoned: 1, failed: 0, incomplete: 1 })
    expect(summary.identities[0]).toMatchObject({ label: 'bot10', posts: 0, replies: 0 })
    expect(summary.identities[0].errors).toEqual([expect.stringMatching(/invalid argument/)])
    // A refused query is a verdict, not a transport fault: asked once.
    expect(chain.sdk.documents.query.mock.calls.filter(([args]) => ownerOfClause(args) === a.id)).toHaveLength(1)
    expect(summary.identities[1]).toMatchObject({ label: 'bot11', tombstoned: 1, failed: 0 })
    expect(chain.find('post', docId(1))).not.toHaveProperty('deleted')
    expect(chain.find('post', docId(20))).toMatchObject({ deleted: true })
  })

  it('counts an identity with no key to sign with as failed, and cleans the next', async () => {
    const chain = createChain()
    const keyless = { id: b58(10), label: 'keyless' }
    const b = bot(11)
    chain.rows.post.push(post(1, keyless.id, T0), post(2, keyless.id, T0 - 1), post(20, b.id, T0))

    const summary = await run(chain, [keyless, b], { live: true })

    expect(summary).toMatchObject({ found: 3, tombstoned: 1, failed: 2, incomplete: 0 })
    expect(summary.identities[0].errors).toEqual([expect.stringMatching(/^cannot sign its tombstones: .*keyless: no key/)])
    expect(replaced(chain).map(({ document }) => document.ownerId)).toEqual([b.id])
  })
})

describe('a scan the page cap cuts short', () => {
  // 50 pages of 100 documents are read per type; the 5001st document and on are left for a resumed run.
  // The fake serves full pages for as long as there are documents, so the cap is hit for real.
  const CAP = 50 * 100
  // The 5001st reply shares its time with the 5000th: the resume has to read through a shared time.
  const createdAt = (i: number) => T0 - (i < CAP ? i : i - 1)

  it('marks the row truncated with its resume point, and a run resumed from there starts after the last document read', async () => {
    const chain = createChain()
    const a = bot(10)
    for (let i = 0; i < CAP + 99; i++) chain.rows.reply.push(reply(i, a.id, createdAt(i)))

    const first = await run(chain, [a])

    const lastRead = CAP - 1
    expect(first).toMatchObject({ found: CAP, incomplete: 1, failed: 0 })
    expect(first.identities[0]).toMatchObject({ posts: 0, replies: CAP, truncated: true })
    expect(first.identities[0].resume).toEqual({ reply: { until: createdAt(lastRead), after: docId(lastRead) } })
    expect(first.identities[0]).not.toHaveProperty('resume.post')
    const replyQueries = queriesOf(chain, 'reply')
    expect(replyQueries).toHaveLength(50)
    expect(replyQueries[0]).not.toHaveProperty('startAfter')
    expect(replyQueries[1].startAfter).toBe(docId(99))
    expect(replyQueries.every((args) => args.limit === 100)).toBe(true)

    chain.sdk.documents.query.mockClear()
    const { until, after } = (first.identities[0].resume as { reply: { until: number; after: string } }).reply
    const second = await run(chain, [a], { until, after: { reply: after } })

    expect(queriesOf(chain, 'reply')[0].startAfter).toBe(docId(lastRead))
    expect(queriesOf(chain, 'reply')[0].where).toEqual([['$ownerId', '==', a.id], ['$createdAt', '<=', until]])
    expect(queriesOf(chain, 'post')[0].where).toContainEqual(['$createdAt', '<=', until])
    expect(queriesOf(chain, 'post')[0]).not.toHaveProperty('startAfter')
    expect(second).toMatchObject({ found: 99, incomplete: 0 })
    expect(second.identities[0]).not.toHaveProperty('truncated')
    // The document sharing the boundary time is read, the one already read is not.
    const documents = second.identities[0].documents as { id: string }[]
    expect(documents[0].id).toBe(docId(CAP))
    expect(documents.map(({ id }) => id)).not.toContain(docId(lastRead))
  })
})

describe('whom the orchestration refuses', () => {
  it('refuses the contract owner before reading or writing anything', async () => {
    const chain = createChain()
    const owner = { ...bot(2, 'owner'), id: CONTRACT_OWNER }

    await expect(run(chain, [bot(10), owner], { live: true })).rejects.toThrow(/refusing to clean owner/)

    expect(chain.sdk.documents.query).not.toHaveBeenCalled()
    expect(chain.sdk.documents.replace).not.toHaveBeenCalled()
  })

  it('refuses an identity on the refuse list, even next to clean ones', async () => {
    const chain = createChain()
    chain.rows.post.push(post(1, b58(10), T0), post(2, MAKER, T0))

    await expect(run(chain, [bot(10), bot(3, 'maker')], { live: true, refuse: [MAKER] })).rejects.toThrow(/refusing to clean maker/)

    expect(chain.sdk.documents.query).not.toHaveBeenCalled()
    expect(chain.sdk.documents.replace).not.toHaveBeenCalled()
  })

  it('stops when the contract is not on this network', async () => {
    const chain = createChain({ contractOwner: null })

    await expect(run(chain, [bot(10)])).rejects.toThrow(/no contract .* on this network/)
    expect(chain.sdk.documents.query).not.toHaveBeenCalled()
  })

  it('stops, before touching the SDK, on a cut whose authors delete for real (v10)', async () => {
    const chain = createChain()

    await expect(run(chain, [bot(10)], { contract: v10 })).rejects.toThrow(/no author tombstone/)
    expect(chain.sdk.contracts.fetch).not.toHaveBeenCalled()
  })
})
