/**
 * v18 likes copy their post's lane: a like carries `postLive` equal to the
 * post's stored `live` (1 listed, 2 written by a restricted author), the
 * reference `where` binds the two (40127 on a mismatch), and a like of a
 * tombstone (no `live`) is refused. A like of a reply names the reply alone.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  get: vi.fn(),
  createDocument: vi.fn(),
  deleteDocumentByValues: vi.fn(),
}))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query, get: mocks.get } }) }))
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { createDocument: mocks.createDocument, deleteDocumentByValues: mocks.deleteDocumentByValues },
}))

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const VIEWER = id(1)
const AUTHOR = id(2)
const POST = id(3)

const storedPost = (fields: Record<string, unknown>) => ({
  toObject: () => ({ $id: POST, $ownerId: AUTHOR, $revision: 1, content: 'x', ...fields }),
})

async function likeService() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v18')
  return (await import('./like-service')).likeService
}

const created = () => mocks.createDocument.mock.calls[0][3] as Record<string, unknown>
const deletedTuples = () => mocks.deleteDocumentByValues.mock.calls.map(([, , , tuple]) => tuple.data as Record<string, unknown>)

beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([])
  mocks.createDocument.mockResolvedValue({ success: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('v18 like of a post', () => {
  it.each([1, 2] as const)('carries postLive %i read off the stored post', async (live) => {
    mocks.get.mockResolvedValue(storedPost({ live, tags: ['dash'] }))
    const service = await likeService()

    await expect(service.likePost(POST, VIEWER, AUTHOR, 'post', { author: AUTHOR, tags: ['dash'] })).resolves.toBe(true)

    expect(mocks.get).toHaveBeenCalledWith(expect.any(String), 'post', POST)
    expect(created()).toMatchObject({ postLive: live, tags: ['dash'] })
    expect(bs58.encode(created().postId as Uint8Array)).toBe(POST)
    expect(bs58.encode(created().postAuthor as Uint8Array)).toBe(AUTHOR)
  })

  it('uses the lane the caller already holds without reading the post', async () => {
    const service = await likeService()

    await service.likePost(POST, VIEWER, AUTHOR, 'post', { author: AUTHOR, tags: [], live: 2 })

    expect(mocks.get).not.toHaveBeenCalled()
    expect(created()).toMatchObject({ postLive: 2 })
  })

  it('sends no like of a tombstone, which has no lane', async () => {
    mocks.get.mockResolvedValue(storedPost({ deleted: true }))
    const service = await likeService()

    await expect(service.likePost(POST, VIEWER, AUTHOR, 'post', { author: AUTHOR, tags: [] })).resolves.toBe(false)

    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it('names the reply alone on a like of a reply', async () => {
    const service = await likeService()

    await expect(service.likePost(POST, VIEWER, AUTHOR, 'reply', { author: AUTHOR })).resolves.toBe(true)

    expect(mocks.get).not.toHaveBeenCalled()
    expect(created()).not.toHaveProperty('postLive')
  })
})

describe('v18 unlike of a post', () => {
  const likeRow = { $id: id(10), $ownerId: VIEWER, postId: POST, postAuthor: AUTHOR }

  beforeEach(() => {
    mocks.query.mockResolvedValue([likeRow])
    mocks.deleteDocumentByValues.mockResolvedValue({ success: true, confirmed: true })
  })

  it('repeats the post\'s lane in the delete-by-values', async () => {
    mocks.get.mockResolvedValue(storedPost({ live: 2 }))
    const service = await likeService()

    await expect(service.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, tags: [] })).resolves.toBe(true)

    expect(deletedTuples()).toHaveLength(1)
    expect(deletedTuples()[0]).toMatchObject({ postLive: 2 })
  })

  it('tries the like\'s own lane, 1 then 2, when the post was tombstoned since', async () => {
    mocks.get.mockResolvedValue(storedPost({ deleted: true }))
    mocks.deleteDocumentByValues
      .mockResolvedValueOnce({ success: false, error: 'mismatch (code=40127)' })
      .mockResolvedValueOnce({ success: true, confirmed: true })
    // The refused delete is settled by the chain, which still holds the like, so the next lane is tried.
    vi.useFakeTimers()
    try {
      const service = await likeService()
      const work = service.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, tags: [] })
      await vi.runAllTimersAsync()
      await expect(work).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }

    expect(deletedTuples().map((data) => data.postLive)).toEqual([1, 2])
  })
})
