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
