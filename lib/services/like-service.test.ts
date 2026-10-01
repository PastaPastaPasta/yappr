import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

// The v9 unlike at an in-memory chain: `like` and `beat` rows answered by
// equality filters, and a delete-by-values that can land, fail to land, and
// report either as confirmed or as an unproven failure. No network.
type Row = Record<string, unknown>
type Where = [string, string, unknown][]

const UNPROVEN_ERROR = 'wait for state transition result timed out'

const chain = vi.hoisted(() => ({
  rows: { like: [] as Row[], beat: [] as Row[] } as Record<string, Row[]>,
  /** Per doctype: does a delete land, and what does the SDK report? */
  deletes: {} as Record<string, { lands: boolean; report: 'confirmed' | 'unproven' }>,
}))
const mocks = vi.hoisted(() => ({ query: vi.fn(), composite: vi.fn(), deleteDocumentByValues: vi.fn() }))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query, composite: mocks.composite } }) }))
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
    : { success: false, confirmed: false, transactionHash: tuple.documentId, error: UNPROVEN_ERROR }
}

const likeRow = (): Row => ({ $id: id(10), $ownerId: VIEWER, $createdAt: LIKE_AT, postId: POST, postAuthor: AUTHOR, hashtag: 'dash' })
const beatRow = (docId: string, createdAt: number, owner = VIEWER): Row => ({ $id: docId, $ownerId: owner, $createdAt: createdAt, postId: POST, hashtag: 'dash' })
const beatDeletes = () => mocks.deleteDocumentByValues.mock.calls.filter(([, docType]) => docType === 'beat')

async function unlike(hashtag = 'dash', { topology = 'v9', kind = 'post' }: { topology?: string; kind?: 'post' | 'reply' } = {}): Promise<boolean> {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const { likeService } = await import('./like-service')
  const work = likeService.unlikePost(POST, VIEWER, kind, { author: AUTHOR, hashtag })
  await vi.runAllTimersAsync()
  return work
}

async function likeServiceOn(topology: string) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return (await import('./like-service')).likeService
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  chain.rows = { like: [likeRow()], beat: [beatRow(id(20), BEAT_AT), beatRow(id(21), BEAT_AT - 5, OTHER)] }
  // The worst case the read-backs exist for: the delete lands but is not proven
  // (beta.5 threw a snapshot error on every one, QA D-05; beta.7 only on a failed wait).
  chain.deletes = { like: { lands: true, report: 'unproven' }, beat: { lands: true, report: 'unproven' } }
  mocks.query.mockImplementation(async (query) => answer(query))
  mocks.deleteDocumentByValues.mockImplementation(async (...args: Parameters<typeof deleteByValues>) => deleteByValues(...args))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('v9 unlike of a tagged post', () => {
  it('removes the beat companion when the like delete lands but is reported unproven', async () => {
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
    chain.deletes.beat = { lands: false, report: 'unproven' }

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
    chain.deletes.like = { lands: false, report: 'unproven' }

    await expect(unlike()).resolves.toBe(false)

    expect(beatDeletes()).toHaveLength(0)
    expect(chain.rows.beat).toHaveLength(2)
  })

  it('touches no beat when the like delete did not land and its readbacks fail', async () => {
    chain.deletes.like = { lands: false, report: 'unproven' }
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
const PAGE = 100
const BOUNDARY_AT = 1_790_000_000_000
const REFUSED = 'startAt/startAfter cursors cannot address an indexOnly position (the synthesized document id is a one-way hash of it); paginate with a range clause on the terminal property instead'

function driveLike({ documentTypeName, where, limit, startAfter }: {
  documentTypeName: string; where: Where; limit: number; startAfter?: string
}): Row[] {
  if (startAfter) throw new Error(REFUSED)
  return (chain.rows[documentTypeName] ?? [])
    .filter((row) => where.every(([field, op, value]) => {
      if (op === '==') return row[field] === value
      if (op === '<=') return (row[field] as number) <= (value as number)
      if (op === '<') return (row[field] as number) < (value as number)
      if (op === '>') return (row[field] as number) > (value as number)
      if (op === 'in') return (value as unknown[]).includes(row[field])
      throw new Error(`unexpected operator ${op}`)
    }))
    .sort((a, b) => (b.$createdAt as number) - (a.$createdAt as number) || String(a.$id).localeCompare(String(b.$id)))
    .slice(0, limit)
}

type Query = { documentTypeName: string; where: Where; orderBy?: unknown[]; limit?: number; startAfter?: string }
const queriesOf = (docType: string): Query[] => mocks.query.mock.calls.map(([query]) => query as Query).filter((query) => query.documentTypeName === docType)
const deleteTupleOf = (docType: string) => mocks.deleteDocumentByValues.mock.calls.find(([, type]) => type === docType)?.[3]

/**
 * Where each topology reads a like's delete tuple from, per kind: the doctype,
 * its target and author fields, and the author-time prefix the walk pins.
 */
const RECOVERY = {
  'v9 like': { topology: 'v9', kind: 'post', docType: 'like', field: 'postId', author: 'postAuthor', pinsTarget: false },
  'v9 likeReply': { topology: 'v9', kind: 'reply', docType: 'likeReply', field: 'replyId', author: 'replyAuthor', pinsTarget: false },
  'v10 like': { topology: 'v10', kind: 'post', docType: 'like', field: 'postId', author: 'postAuthor', pinsTarget: true },
  'v10 likeReply': { topology: 'v10', kind: 'reply', docType: 'likeReply', field: 'replyId', author: 'replyAuthor', pinsTarget: true },
} as const

describe.each(Object.entries(RECOVERY))('%s unlike when the like is not among the newest 100 on the index', (_label, surface) => {
  const likeAt = (n: number, createdAt: number, owner: string, target: string): Row => ({
    $id: `like-${String(n).padStart(4, '0')}`, $ownerId: owner, $createdAt: createdAt, [surface.field]: target, [surface.author]: AUTHOR,
  })
  // On v10 the walk is pinned on the target, so the crowd must like the SAME
  // post to push the viewer off page one; on v9 any of the author's posts do.
  const crowdTarget = surface.pinsTarget ? POST : OTHER
  const prefix: Where = surface.pinsTarget
    ? [[surface.author, '==', AUTHOR], [surface.field, '==', POST]]
    : [[surface.author, '==', AUTHOR]]
  const orderBy = surface.pinsTarget
    ? [[surface.author, 'asc'], [surface.field, 'asc'], ['$createdAt', 'desc']]
    : [[surface.author, 'asc'], ['$createdAt', 'desc']]
  const run = () => unlike('', { topology: surface.topology, kind: surface.kind })
  /** The tuple walk's reads, told apart from the liked-state readback by their orderBy. */
  const walkOf = () => queriesOf(surface.docType).filter((query) => JSON.stringify(query.orderBy) === JSON.stringify(orderBy))

  beforeEach(() => {
    mocks.query.mockImplementation(async (query) => driveLike(query))
    chain.deletes = { [surface.docType]: { lands: true, report: 'confirmed' }, beat: { lands: true, report: 'confirmed' } }
  })

  it('pages with an inclusive $createdAt keyset and no startAfter, and finds a like on page two', async () => {
    // 100 newer likes by other people fill page one; the viewer's is the 101st.
    const others = Array.from({ length: PAGE }, (_, i) => likeAt(i + 1, BOUNDARY_AT + 1_000 - i, id(100 + (i % 100)), crowdTarget))
    const mine = likeAt(500, BOUNDARY_AT - 500, VIEWER, POST)
    chain.rows = { [surface.docType]: [...others, mine], beat: [] }

    await expect(run()).resolves.toBe(true)

    const queries = walkOf()
    expect(queries).toHaveLength(2)
    expect(queries[0].where).toEqual(prefix)
    expect(queries[1].where).toEqual([...prefix, ['$createdAt', '<=', others[PAGE - 1].$createdAt]])
    for (const query of queries) {
      expect(query.orderBy).toEqual(orderBy)
      expect(query.limit).toBe(PAGE)
      expect(query).not.toHaveProperty('startAfter')
    }
    expect(deleteTupleOf(surface.docType)).toMatchObject({ documentId: mine.$id, createdAtMs: mine.$createdAt })
    expect(chain.rows[surface.docType]).not.toContainEqual(mine)
  })

  it('does not skip a like that shares a timestamp with the last row of the previous page', async () => {
    // Row 100 of page one and the viewer's like land on the same millisecond;
    // a strict `<` bound would drop the viewer's like between the pages.
    const others = Array.from({ length: PAGE - 1 }, (_, i) => likeAt(i + 1, BOUNDARY_AT + 1_000 - i, id(100 + (i % 100)), crowdTarget))
    const tieOther = likeAt(200, BOUNDARY_AT, id(201), crowdTarget)
    const mine = likeAt(300, BOUNDARY_AT, VIEWER, POST)
    chain.rows = { [surface.docType]: [...others, tieOther, mine, likeAt(400, BOUNDARY_AT - 1, id(202), crowdTarget)], beat: [] }

    await expect(run()).resolves.toBe(true)

    expect(walkOf()[1].where).toContainEqual(['$createdAt', '<=', BOUNDARY_AT])
    expect(deleteTupleOf(surface.docType)).toMatchObject({ documentId: mine.$id, createdAtMs: BOUNDARY_AT })
  })

  it('stops instead of looping when a page adds nothing new', async () => {
    // More than a page of likes on one timestamp: the inclusive bound can only
    // ever re-serve the same rows, so the walk must end rather than spin.
    const crowd = Array.from({ length: PAGE + 20 }, (_, i) => likeAt(i + 1, BOUNDARY_AT, id(100 + (i % 100)), crowdTarget))
    chain.rows = { [surface.docType]: [...crowd, likeAt(999, BOUNDARY_AT - 10, VIEWER, POST)], beat: [] }

    await run()

    const walk = walkOf()
    expect(walk.length).toBeLessThanOrEqual(2)
    expect(mocks.deleteDocumentByValues).not.toHaveBeenCalled()
  })
})

describe('liked state ("did I like these?")', () => {
  beforeEach(() => {
    mocks.query.mockImplementation(async (query) => driveLike(query))
    chain.rows = {
      like: [likeRow(), { ...likeRow(), $id: id(11), $ownerId: OTHER, postId: OTHER }],
      likeReply: [{ $id: id(12), $ownerId: VIEWER, $createdAt: LIKE_AT, replyId: POST, replyAuthor: AUTHOR }],
    }
  })

  it.each([
    ['post', 'like', 'postId'],
    ['reply', 'likeReply', 'replyId'],
  ] as const)('v10 batches a %s page as one target `in` with the owner pinned below it (byPost/byReply)', async (kind, docType, field) => {
    const likeService = await likeServiceOn('v10')

    expect(await likeService.getUserLikedPostIds(VIEWER, [POST, OTHER], kind)).toEqual(new Set([POST]))

    expect(queriesOf(docType)).toEqual([expect.objectContaining({
      where: [[field, 'in', [POST, OTHER]], ['$ownerId', '==', VIEWER]],
      orderBy: [[field, 'asc'], ['$ownerId', 'asc']],
      limit: 2,
    })])
  })

  it('v10 reads one target with both equalities, target first, and no orderBy (the proven shape)', async () => {
    const likeService = await likeServiceOn('v10')

    expect(await likeService.isLiked(POST, VIEWER, 'post')).toBe(true)

    const reads = queriesOf('like')
    expect(reads).toEqual([expect.objectContaining({
      where: [['postId', '==', POST], ['$ownerId', '==', VIEWER]],
      limit: 1,
    })])
    expect(reads[0].orderBy).toBeUndefined()
  })

  it('v9 keeps the owner-first byLiker batch', async () => {
    const likeService = await likeServiceOn('v9')

    expect(await likeService.getUserLikedPostIds(VIEWER, [POST, OTHER], 'post')).toEqual(new Set([POST]))

    expect(queriesOf('like')).toEqual([expect.objectContaining({
      where: [['$ownerId', '==', VIEWER], ['postId', 'in', [POST, OTHER]]],
      orderBy: [['$ownerId', 'asc'], ['postId', 'asc']],
      limit: 2,
    })])
  })
})

describe('v10 like notifications: recent content → like counts → one read per kind', () => {
  const ME = AUTHOR
  const SINCE = 1_790_000_000_000
  // My 12 newest posts, newest first; the 5th has no likes.
  const mine = Array.from({ length: 12 }, (_, i) => ({ $id: id(50 + i), $ownerId: ME, $createdAt: SINCE - i * 1_000 }))
  const counts = new Map(mine.map((doc, i) => [doc.$id, BigInt(i === 4 ? 0 : 3)]))

  beforeEach(() => {
    mocks.composite.mockResolvedValue({ pageDocuments: [...mine].reverse(), subResults: [{ kind: 'counts', counts }] })
    mocks.query.mockImplementation(async (query) => driveLike(query))
  })

  it.each([
    ['post', 'like', 'postId', 'postAuthor'],
    ['reply', 'likeReply', 'replyId', 'replyAuthor'],
  ] as const)('reads likes of every liked recent %s since the watermark in one `in` read', async (kind, docType, field, author) => {
    chain.rows = {
      [docType]: [
        { $id: 'old', $ownerId: OTHER, $createdAt: SINCE - 5, [field]: mine[0].$id, [author]: ME },
        { $id: 'new', $ownerId: OTHER, $createdAt: SINCE + 5, [field]: mine[0].$id, [author]: ME },
        { $id: 'newer', $ownerId: VIEWER, $createdAt: SINCE + 9, [field]: mine[2].$id, [author]: ME },
        // The 12th (oldest) recent target is still read: no ten-target cap.
        { $id: 'late', $ownerId: VIEWER, $createdAt: SINCE + 7, [field]: mine[11].$id, [author]: ME },
        // Not one of my recent targets: never asked for.
        { $id: 'stray', $ownerId: VIEWER, $createdAt: SINCE + 8, [field]: POST, [author]: ME },
      ],
    }
    const likeService = await likeServiceOn('v10')

    const likes = await likeService.getLikesOnMyPosts(ME, new Date(SINCE), kind)

    // One composite: my newest content on ownerAndTime (50 read, the first 20
    // that are not bare reposts kept) + their like counts.
    expect(mocks.composite).toHaveBeenCalledTimes(1)
    expect(mocks.composite.mock.calls[0][0]).toMatchObject({
      documentType: kind,
      where: [['$ownerId', '==', ME], ['$createdAt', '>', 0]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: 50,
      subQueries: [{ documentType: docType, kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field } }],
    })
    // One plain read over every liked target (the unliked 5th skipped), since-filtered.
    const reads = queriesOf(docType)
    expect(reads).toHaveLength(1)
    expect(reads[0].where).toEqual([[author, '==', ME], [field, 'in', mine.filter((_, i) => i !== 4).map((doc) => doc.$id)], ['$createdAt', '>', SINCE]])
    expect(reads[0].orderBy).toEqual([[author, 'asc'], [field, 'asc'], ['$createdAt', 'desc']])
    expect(reads[0].limit).toBe(100)
    // Each row's target is read off the row itself.
    expect(likes.map(({ $ownerId, $createdAt, postId, targetKind }) => ({ $ownerId, $createdAt, postId, targetKind }))).toEqual([
      { $ownerId: VIEWER, $createdAt: SINCE + 9, postId: mine[2].$id, targetKind: kind },
      { $ownerId: VIEWER, $createdAt: SINCE + 7, postId: mine[11].$id, targetKind: kind },
      { $ownerId: OTHER, $createdAt: SINCE + 5, postId: mine[0].$id, targetKind: kind },
    ])
  })

  it('falls back to per-target keyset reads when the one `in` read comes back full, so no like is passed over', async () => {
    const crowd = Array.from({ length: 100 }, (_, i) => ({ $id: `crowd-${i}`, $ownerId: id(300 + i), $createdAt: SINCE + 100 + i, postId: mine[0].$id, postAuthor: ME }))
    const quiet = { $id: 'quiet', $ownerId: VIEWER, $createdAt: SINCE + 1, postId: mine[2].$id, postAuthor: ME }
    chain.rows = { like: [...crowd, quiet] }
    const likeService = await likeServiceOn('v10')

    const likes = await likeService.getLikesOnMyPosts(ME, new Date(SINCE), 'post')

    // Every like since the watermark, the quiet target's included.
    expect(likes).toHaveLength(101)
    expect(likes.some((like) => like.postId === mine[2].$id && like.$ownerId === VIEWER)).toBe(true)
    const reads = queriesOf('like')
    // The `in` read, then one read per liked target; the crowded one is paged
    // on an inclusive $createdAt keyset, never an id cursor.
    expect(reads[0].where).toContainEqual(['postId', 'in', mine.filter((_, i) => i !== 4).map((doc) => doc.$id)])
    expect(reads.some((read) => read.where.some(([field, op]) => field === '$createdAt' && op === '<='))).toBe(true)
    for (const read of reads) expect(read).not.toHaveProperty('startAfter')
  })

  it('skips my own bare reposts when choosing the recent posts, so a heavy reposter\'s posts still notify', async () => {
    // 25 bare reposts newer than any real post, then my 12 real posts.
    const reposts = Array.from({ length: 25 }, (_, i) => ({ $id: id(200 + i), $ownerId: ME, $createdAt: SINCE + 1_000 + i, quotedPostId: POST }))
    const page = [...reposts, ...mine]
    mocks.composite.mockResolvedValue({ pageDocuments: page, subResults: [{ kind: 'counts', counts: new Map(page.map((doc) => [doc.$id, 3n])) }] })
    chain.rows = { like: [] }
    const likeService = await likeServiceOn('v10')

    await likeService.getLikesOnMyPosts(ME, new Date(SINCE), 'post')

    const inClause = queriesOf('like')[0].where.find(([field, op]) => field === 'postId' && op === 'in')
    expect(inClause?.[2]).toEqual(mine.map((doc) => doc.$id))
  })

  it('reads nothing more when no recent post has a like', async () => {
    mocks.composite.mockResolvedValue({ pageDocuments: mine, subResults: [{ kind: 'counts', counts: new Map() }] })
    const likeService = await likeServiceOn('v10')

    expect(await likeService.getLikesOnMyPosts(ME, new Date(SINCE), 'post')).toEqual([])
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('returns nothing rather than a partial answer when the read fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('DAPI unavailable'))
    const likeService = await likeServiceOn('v10')

    expect(await likeService.getLikesOnMyPosts(ME, new Date(SINCE), 'post')).toEqual([])
  })

  it('v9 keeps the single author-pinned read', async () => {
    const likeService = await likeServiceOn('v9')

    await likeService.getLikesOnMyPosts(ME, new Date(SINCE), 'post')

    expect(mocks.composite).not.toHaveBeenCalled()
    expect(queriesOf('like')).toEqual([expect.objectContaining({
      where: [['postAuthor', '==', ME], ['$createdAt', '>', SINCE]],
      orderBy: [['postAuthor', 'asc'], ['$createdAt', 'desc']],
    })])
  })
})

describe('v11 unlike (outlivesDelete): content values only, no $createdAt', () => {
  const run = (kind: 'post' | 'reply' = 'post') => unlike('dash', { topology: 'v11', kind })

  beforeEach(() => {
    mocks.query.mockImplementation(async (query) => driveLike(query))
    chain.deletes = { like: { lands: true, report: 'confirmed' }, likeReply: { lands: true, report: 'confirmed' } }
  })

  it.each([
    ['post', 'like', { postId: POST, postAuthor: AUTHOR, hashtag: 'dash' }, 'postId'],
    ['reply', 'likeReply', { replyId: POST, replyAuthor: AUTHOR }, 'replyId'],
  ] as const)('deletes a %s like by its content values after one liked-state read, with no tuple walk', async (kind, docType, values, field) => {
    chain.rows = { [docType]: [{ $id: id(10), $ownerId: VIEWER, ...values }] }

    await expect(run(kind)).resolves.toBe(true)

    // The only read is the liked-state readback (target, owner) — no author-time walk.
    expect(queriesOf(docType).map((query) => query.where)).toEqual([[[field, '==', POST], ['$ownerId', '==', VIEWER]]])
    const tuple = deleteTupleOf(docType)
    expect(tuple).not.toHaveProperty('createdAtMs')
    expect(tuple?.documentId).toBe(id(10))
    const data = tuple?.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(Object.keys(values).sort())
    expect(bs58.encode(data[field] as Uint8Array)).toBe(POST)
    expect(chain.rows[docType]).toEqual([])
  })

  it('is a no-op success when there is no like to remove', async () => {
    chain.rows = { like: [] }

    await expect(run()).resolves.toBe(true)

    expect(mocks.deleteDocumentByValues).not.toHaveBeenCalled()
  })

  it('fails rather than passing a failed liked-state read off as "not liked"', async () => {
    mocks.query.mockRejectedValue(new Error('DAPI unavailable'))

    await expect(run()).resolves.toBe(false)

    expect(mocks.deleteDocumentByValues).not.toHaveBeenCalled()
  })

  it('believes the chain when the delete is reported unproven', async () => {
    chain.rows = { like: [likeRow()] }
    chain.deletes.like = { lands: true, report: 'unproven' }

    await expect(run()).resolves.toBe(true)
  })
})

describe('v11 timeless like notification reads', () => {
  const ME = AUTHOR
  const [P1, P2] = [id(60), id(61)]
  const likeOf = (owner: string, target: string, docType = 'like'): Row => docType === 'like'
    ? { $id: `${owner}-${target}`, $ownerId: owner, postId: target, postAuthor: ME }
    : { $id: `${owner}-${target}`, $ownerId: owner, replyId: target, replyAuthor: ME }

  // Answers in index key order: by target, then by liker.
  const keyOrder = (field: string) => async (query: Query) => {
    if (query.startAfter) throw new Error(REFUSED)
    return (chain.rows[query.documentTypeName] ?? []).filter((row) => query.where.every(([property, op, value]) => {
      if (op === '==') return row[property] === value
      if (op === 'in') return (value as unknown[]).includes(row[property])
      if (op === '>') return String(row[property]) > String(value)
      throw new Error(`unexpected operator ${op}`)
    })).sort((a, b) => String(a[field]).localeCompare(String(b[field])) || String(a.$ownerId).localeCompare(String(b.$ownerId)))
      .slice(0, query.limit)
  }

  it.each([
    ['post', 'like', 'postId', 'postAuthor'],
    ['reply', 'likeReply', 'replyId', 'replyAuthor'],
  ] as const)('reads the likers of every moved %s in one author-pinned `in` read on the author index', async (kind, docType, field, author) => {
    chain.rows = { [docType]: [likeOf(VIEWER, P1, docType), likeOf(OTHER, P1, docType), likeOf(OTHER, P2, docType)] }
    mocks.query.mockImplementation(keyOrder(field))
    const likeService = await likeServiceOn('v11')

    const likers = await likeService.getLikersOf(ME, [P1, P2], kind)

    expect(queriesOf(docType)).toEqual([{
      dataContractId: expect.any(String),
      documentTypeName: docType,
      where: [[author, '==', ME], [field, 'in', [P1, P2]]],
      orderBy: [[author, 'asc'], [field, 'asc']],
      limit: 100,
    }])
    expect(likers.get(P1)).toEqual({ likers: [VIEWER, OTHER].sort(), complete: true })
    expect(likers.get(P2)).toEqual({ likers: [OTHER], complete: true })
  })

  it('when the `in` read comes back full, re-reads from the last row\'s target on, paged on byPost with an `$ownerId >` keyset, capped at three pages', async () => {
    // P1 sorts before P2: its one like is complete in the full page; P2's crowd fills the rest.
    const crowd = Array.from({ length: 650 }, (_, i) => likeOf(`liker-${String(i).padStart(4, '0')}`, P2))
    chain.rows = { like: [likeOf(VIEWER, P1), ...crowd] }
    mocks.query.mockImplementation(keyOrder('postId'))
    const likeService = await likeServiceOn('v11')

    const likers = await likeService.getLikersOf(ME, [P1, P2], 'post')

    expect(likers.get(P1)).toEqual({ likers: [VIEWER], complete: true })
    expect(likers.get(P2)?.complete).toBe(false)
    expect(likers.get(P2)?.likers).toHaveLength(300)
    const perTarget = queriesOf('like').slice(1)
    expect(perTarget.map((query) => query.where)).toEqual([
      [['postId', '==', P2]],
      [['postId', '==', P2], ['$ownerId', '>', 'liker-0099']],
      [['postId', '==', P2], ['$ownerId', '>', 'liker-0199']],
    ])
    for (const query of perTarget) expect(query).toMatchObject({ orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 })
    for (const query of queriesOf('like')) expect(query).not.toHaveProperty('startAfter')
  })

  it('never asks the author index for likes since a time', async () => {
    const likeService = await likeServiceOn('v11')

    expect(await likeService.getLikesOnMyPosts(ME, new Date(1_000), 'post')).toEqual([])

    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.composite).not.toHaveBeenCalled()
  })
})
