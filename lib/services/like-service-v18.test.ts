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

/**
 * The committed v18 social contract with its `like` type's `postLive` kept or
 * dropped (#883 drops it): the client follows the file, not the version.
 */
async function mockContract(withPostLive: boolean) {
  const { default: committed } = await import('@/contracts/yappr-social-contract-v18.json')
  const like = committed.documentSchemas.like
  const properties: Record<string, unknown> = { ...like.properties }
  if (withPostLive) properties.postLive ??= { type: 'integer' }
  else delete properties.postLive
  vi.doMock('@/contracts/yappr-social-contract-v18.json', () => ({
    default: { ...committed, documentSchemas: { ...committed.documentSchemas, like: { ...like, properties } } },
  }))
}

async function likeModule(withPostLive = true) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v18')
  await mockContract(withPostLive)
  return import('./like-service')
}

async function likeService(withPostLive = true) {
  return (await likeModule(withPostLive)).likeService
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
  vi.doUnmock('@/contracts/yappr-social-contract-v18.json')
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
    // A refusal means the delete did not run: the next lane is tried at once, with no read-back wait.
    const service = await likeService()

    await expect(service.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, tags: [] })).resolves.toBe(true)

    expect(deletedTuples().map((data) => data.postLive)).toEqual([1, 2])
    // Only the liked-state read before the delete: no read-back between the two tries.
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('settles an unconfirmed delete by the chain before trying another lane', async () => {
    mocks.get.mockResolvedValue(storedPost({ deleted: true }))
    mocks.deleteDocumentByValues
      .mockResolvedValueOnce({ success: false, error: 'wait for state transition result timed out' })
      .mockResolvedValueOnce({ success: true, confirmed: true })
    // The like is gone on the read-back: the first delete landed.
    mocks.query.mockResolvedValueOnce([likeRow]).mockResolvedValue([])
    const service = await likeService()

    await expect(service.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, tags: [] })).resolves.toBe(true)

    expect(deletedTuples()).toHaveLength(1)
  })

  it('does not read the post when the card already knows its lane', async () => {
    const service = await likeService()

    await service.unlikePost(POST, VIEWER, 'post', { author: AUTHOR, tags: [], live: 2 })

    expect(mocks.get).not.toHaveBeenCalled()
    expect(deletedTuples()).toEqual([expect.objectContaining({ postLive: 2 })])
  })
})

describe('the lane a card already knows', () => {
  it('is 1 without marks, 2 for a restricted author, and unknown for a tombstone, a reply or an older cut', async () => {
    const v18 = await likeModule()
    expect(v18.knownPostLane({}, 'post')).toBe(1)
    expect(v18.knownPostLane({ moderation: { restricted: false } }, 'post')).toBe(1)
    expect(v18.knownPostLane({ moderation: { restricted: true } }, 'post')).toBe(2)
    expect(v18.knownPostLane({ deleted: true }, 'post')).toBeUndefined()
    expect(v18.knownPostLane({}, 'reply')).toBeUndefined()
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
    expect((await import('./like-service')).knownPostLane({}, 'post')).toBeUndefined()
  })
})

describe('a v18 file whose like type has no postLive', () => {
  const likeRow = { $id: id(10), $ownerId: VIEWER, postId: POST, postAuthor: AUTHOR }
  const info = { author: AUTHOR, tags: [] as string[] }

  beforeEach(() => {
    mocks.query.mockResolvedValue([likeRow])
    mocks.deleteDocumentByValues.mockResolvedValue({ success: true, confirmed: true })
  })

  it('writes the like as v17 does: no postLive, no read of the post, even when the card knows a lane', async () => {
    mocks.query.mockResolvedValue([])
    const service = await likeService(false)

    await expect(service.likePost(POST, VIEWER, AUTHOR, 'post', { ...info, live: 2 })).resolves.toBe(true)

    expect(mocks.get).not.toHaveBeenCalled()
    expect(created()).not.toHaveProperty('postLive')
  })

  it('unlikes with one delete and no lane probing, also after a refusal', async () => {
    mocks.deleteDocumentByValues.mockResolvedValue({ success: false, error: 'mismatch (code=40127)' })
    const service = await likeService(false)

    await expect(service.unlikePost(POST, VIEWER, 'post', info)).resolves.toBe(false)

    expect(mocks.get).not.toHaveBeenCalled()
    expect(deletedTuples()).toHaveLength(1)
    expect(deletedTuples()[0]).not.toHaveProperty('postLive')
  })

  it('knows no lane for any card', async () => {
    const { knownPostLane } = await likeModule(false)
    expect(knownPostLane({}, 'post')).toBeUndefined()
    expect(knownPostLane({ moderation: { restricted: true } }, 'post')).toBeUndefined()
  })
})
