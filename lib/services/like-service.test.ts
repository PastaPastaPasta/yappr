import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

// The v9 unlike at an in-memory chain: `like` and `beat` rows answered by
// equality filters, and a delete-by-values that can land, fail to land, and
// report either the way evo-sdk 4.2.0-beta.5 does. No network.
type Row = Record<string, unknown>
type Where = [string, string, unknown][]

const SNAPSHOT_ERROR = '[WASM] received a verified VerifiedDocuments snapshot for this transition family; use the *_affected_state wait APIs and treat the result as a height-pinned snapshot'

const chain = vi.hoisted(() => ({
  rows: { like: [] as Row[], beat: [] as Row[] } as Record<string, Row[]>,
  /** Per doctype: does a delete land, and what does the SDK report? */
  deletes: {} as Record<string, { lands: boolean; report: 'confirmed' | 'snapshot' }>,
}))
const mocks = vi.hoisted(() => ({ query: vi.fn(), deleteDocumentByValues: vi.fn() }))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query } }) }))
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { deleteDocumentByValues: mocks.deleteDocumentByValues },
}))

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const VIEWER = id(1)
const AUTHOR = id(2)
const POST = id(3)
const OTHER = id(4)
const LIKE_AT = 1_790_562_900_000
const BEAT_AT = 1_790_562_962_816

function answer({ documentTypeName, where }: { documentTypeName: string; where: Where }): Row[] {
  return (chain.rows[documentTypeName] ?? []).filter((row) =>
    where.every(([field, op, value]) => op !== '==' || row[field] === value)
  )
}

function deleteByValues(_contract: string, docType: string, _owner: string, tuple: { documentId: string }) {
  const behaviour = chain.deletes[docType] ?? { lands: true, report: 'confirmed' }
  if (behaviour.lands) chain.rows[docType] = chain.rows[docType].filter((row) => row.$id !== tuple.documentId)
  return behaviour.report === 'confirmed'
    ? { success: true, confirmed: true, transactionHash: tuple.documentId }
    : { success: false, confirmed: false, transactionHash: tuple.documentId, error: SNAPSHOT_ERROR }
}

const likeRow = (): Row => ({ $id: id(10), $ownerId: VIEWER, $createdAt: LIKE_AT, postId: POST, postAuthor: AUTHOR, hashtag: 'dash' })
const beatRow = (docId: string, createdAt: number, owner = VIEWER): Row => ({ $id: docId, $ownerId: owner, $createdAt: createdAt, postId: POST, hashtag: 'dash' })
const beatDeletes = () => mocks.deleteDocumentByValues.mock.calls.filter(([, docType]) => docType === 'beat')

async function unlike(hashtag = 'dash'): Promise<boolean> {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
  const { likeService } = await import('./like-service')
  const work = likeService.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, hashtag })
  await vi.runAllTimersAsync()
  return work
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  chain.rows = { like: [likeRow()], beat: [beatRow(id(20), BEAT_AT), beatRow(id(21), BEAT_AT - 5, OTHER)] }
  // What beta.5 does on every indexOnly delete (QA D-05): it lands, then throws.
  chain.deletes = { like: { lands: true, report: 'snapshot' }, beat: { lands: true, report: 'snapshot' } }
  mocks.query.mockImplementation(async (query) => answer(query))
  mocks.deleteDocumentByValues.mockImplementation(async (...args: Parameters<typeof deleteByValues>) => deleteByValues(...args))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('v9 unlike of a tagged post', () => {
  it('removes the beat companion when the like delete lands but reports the snapshot error', async () => {
    await expect(unlike()).resolves.toBe(true)

    expect(chain.rows.like).toEqual([])
    const [call] = beatDeletes()
    expect(call?.[3]).toMatchObject({ documentId: id(20), createdAtMs: BEAT_AT })
    // Only the viewer's beat goes; another liker's stays.
    expect(chain.rows.beat.map((row) => row.$id)).toEqual([id(21)])
  })

  it('confirms an unproven beat delete by reading its exact byPostTime key back', async () => {
    await unlike()

    const readback = mocks.query.mock.calls.map(([query]) => query).find((query) =>
      query.documentTypeName === 'beat' && (query.where as Where).some(([field]) => field === '$createdAt')
    )
    expect(readback?.where).toEqual([['postId', '==', POST], ['$createdAt', '==', BEAT_AT]])
  })

  it('still reports the unlike as done when the beat delete does not land, after retrying the readback', async () => {
    chain.deletes.beat = { lands: false, report: 'snapshot' }

    await expect(unlike()).resolves.toBe(true)

    expect(beatDeletes()).toHaveLength(1)
    expect(chain.rows.beat.map((row) => row.$id)).toContain(id(20))
    const readbacks = mocks.query.mock.calls.filter(([query]) =>
      query.documentTypeName === 'beat' && (query.where as Where).some(([field]) => field === '$createdAt')
    )
    expect(readbacks).toHaveLength(3)
  })

  it('also clears a beat an earlier unlike left behind', async () => {
    chain.rows.beat.push(beatRow(id(22), BEAT_AT - 86_000_000))

    await unlike()

    expect(beatDeletes().map(([, , , tuple]) => tuple.documentId)).toEqual([id(20), id(22)])
    expect(chain.rows.beat.map((row) => row.$id)).toEqual([id(21)])
  })

  it('touches no beat when the like delete did not land', async () => {
    chain.deletes.like = { lands: false, report: 'snapshot' }

    await expect(unlike()).resolves.toBe(false)

    expect(beatDeletes()).toHaveLength(0)
    expect(chain.rows.beat).toHaveLength(2)
  })

  it('touches no beat when the like delete did not land and its readbacks fail', async () => {
    chain.deletes.like = { lands: false, report: 'snapshot' }
    // Once the delete is sent, every like read errors: a failed read must not
    // pass for "the like is gone".
    mocks.query.mockImplementation(async (query) => {
      if (query.documentTypeName === 'like' && mocks.deleteDocumentByValues.mock.calls.length > 0) {
        throw new Error('DAPI unavailable')
      }
      return answer(query)
    })

    await expect(unlike()).resolves.toBe(false)

    expect(beatDeletes()).toHaveLength(0)
    expect(chain.rows.beat).toHaveLength(2)
  })

  it('removes the beat after a confirmed like delete too', async () => {
    chain.deletes = { like: { lands: true, report: 'confirmed' }, beat: { lands: true, report: 'confirmed' } }

    await expect(unlike()).resolves.toBe(true)

    expect(chain.rows.beat.map((row) => row.$id)).toEqual([id(21)])
  })
})

describe('v9 unlike of an untagged post', () => {
  it('writes no beat delete', async () => {
    chain.rows.like = [{ ...likeRow(), hashtag: undefined }]

    await expect(unlike('')).resolves.toBe(true)

    expect(beatDeletes()).toHaveLength(0)
  })
})

// A chain that answers like Drive does for an indexOnly doctype: synthesized ids
// address nothing, so a startAfter cursor is refused outright (the live message
// on bonsia), and the only way past page one is a range clause on the terminal.
describe('v9 unlike when the like is not among the newest 100 on the author', () => {
  const PAGE = 100
  const BOUNDARY_AT = 1_790_000_000_000
  const REFUSED = 'startAt/startAfter cursors cannot address an indexOnly position (the synthesized document id is a one-way hash of it); paginate with a range clause on the terminal property instead'

  const likeAt = (n: number, createdAt: number, owner: string, postId: string): Row => ({
    $id: `like-${String(n).padStart(4, '0')}`, $ownerId: owner, $createdAt: createdAt, postId, postAuthor: AUTHOR, hashtag: undefined,
  })

  function driveLike({ documentTypeName, where, limit, startAfter }: {
    documentTypeName: string; where: Where; limit: number; startAfter?: string
  }): Row[] {
    if (startAfter) throw new Error(REFUSED)
    return (chain.rows[documentTypeName] ?? [])
      .filter((row) => where.every(([field, op, value]) => {
        if (op === '==') return row[field] === value
        if (op === '<=') return (row[field] as number) <= (value as number)
        if (op === '<') return (row[field] as number) < (value as number)
        throw new Error(`unexpected operator ${op}`)
      }))
      .sort((a, b) => (b.$createdAt as number) - (a.$createdAt as number) || String(a.$id).localeCompare(String(b.$id)))
      .slice(0, limit)
  }

  const likeQueries = () => mocks.query.mock.calls.map(([query]) => query).filter((query) => query.documentTypeName === 'like')
  const likeDeleteTuple = () => mocks.deleteDocumentByValues.mock.calls.find(([, docType]) => docType === 'like')?.[3]

  beforeEach(() => {
    mocks.query.mockImplementation(async (query) => driveLike(query))
    chain.deletes = { like: { lands: true, report: 'confirmed' }, beat: { lands: true, report: 'confirmed' } }
  })

  it('pages with a $createdAt range and no startAfter, and finds a like on page two', async () => {
    // 100 newer likes by other people fill page one; the viewer's is the 101st.
    const others = Array.from({ length: PAGE }, (_, i) => likeAt(i + 1, BOUNDARY_AT + 1_000 - i, id(100 + (i % 100)), OTHER))
    const mine = likeAt(500, BOUNDARY_AT - 500, VIEWER, POST)
    chain.rows.like = [...others, mine]

    await expect(unlike('')).resolves.toBe(true)

    const queries = likeQueries()
    expect(queries).toHaveLength(2)
    expect(queries[0].where).toEqual([['postAuthor', '==', AUTHOR]])
    expect(queries[1].where).toEqual([['postAuthor', '==', AUTHOR], ['$createdAt', '<=', others[PAGE - 1].$createdAt]])
    expect(queries[1].orderBy).toEqual([['postAuthor', 'asc'], ['$createdAt', 'desc']])
    for (const query of queries) expect(query).not.toHaveProperty('startAfter')
    expect(likeDeleteTuple()).toMatchObject({ documentId: mine.$id, createdAtMs: mine.$createdAt })
    expect(chain.rows.like).not.toContainEqual(mine)
  })

  it('does not skip a like that shares a timestamp with the last row of the previous page', async () => {
    // Row 100 of page one and the viewer's like land on the same millisecond;
    // a strict `<` bound would drop the viewer's like between the pages.
    const others = Array.from({ length: PAGE - 1 }, (_, i) => likeAt(i + 1, BOUNDARY_AT + 1_000 - i, id(100 + (i % 100)), OTHER))
    const tieOther = likeAt(200, BOUNDARY_AT, id(201), OTHER)
    const mine = likeAt(300, BOUNDARY_AT, VIEWER, POST)
    chain.rows.like = [...others, tieOther, mine, likeAt(400, BOUNDARY_AT - 1, id(202), OTHER)]

    await expect(unlike('')).resolves.toBe(true)

    expect(likeQueries()[1].where).toContainEqual(['$createdAt', '<=', BOUNDARY_AT])
    expect(likeDeleteTuple()).toMatchObject({ documentId: mine.$id, createdAtMs: BOUNDARY_AT })
  })

  it('stops instead of looping when a page adds nothing new', async () => {
    // More than a page of likes on one timestamp: the inclusive bound can only
    // ever re-serve the same rows, so the walk must end rather than spin.
    chain.rows.like = Array.from({ length: PAGE + 20 }, (_, i) => likeAt(i + 1, BOUNDARY_AT, id(100 + (i % 100)), OTHER))
    chain.rows.like.push(likeAt(999, BOUNDARY_AT - 10, VIEWER, POST))

    await unlike('')

    expect(likeQueries().length).toBeLessThanOrEqual(3)
    expect(mocks.deleteDocumentByValues).not.toHaveBeenCalled()
  })
})
