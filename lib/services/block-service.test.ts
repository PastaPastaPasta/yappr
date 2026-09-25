import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { addOwnBlock, getOwnBlocksFromCache, invalidateBlockCache, removeOwnBlock, setBlockFollows } from '../caches/block-cache'

const { query, deleteDocument } = vi.hoisted(() => ({ query: vi.fn(), deleteDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { deleteDocument } }))
import { blockService } from './block-service'

const identity = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? n : 1))
const viewer = identity(250)
const authors = Array.from({ length: 120 }, (_, i) => identity(i + 1))
const block = (blockedId: string, index = 0, owner = viewer) => ({
  $id: identity(index + 1), $ownerId: owner, $createdAt: 1000, blockedId,
})
const blockQueries = () => query.mock.calls.filter(([q]) => q.documentTypeName === 'block')

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  query.mockReset().mockResolvedValue([])
  deleteDocument.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('feed block query budget', () => {
  it('shares one owner query between auth, 40 cards and overlapping feed batches', async () => {
    const targets = authors.slice(0, 20)
    const [_, batch, ...cards] = await Promise.all([
      blockService.initializeBlockData(viewer),
      blockService.checkBlockedBatch(viewer, targets),
      ...[...targets, ...targets].map(id => blockService.isBlocked(id, viewer)),
      blockService.checkBlockedBatch(viewer, targets.slice(5)),
    ])
    expect([...batch.values()]).toEqual(targets.map(() => false))
    expect(cards.slice(0, 40)).toEqual(Array(40).fill(false))
    expect(blockQueries()).toHaveLength(1)
    expect(blockQueries()[0][0].where).toEqual([['$ownerId', '==', viewer]])
    expect(query.mock.calls.filter(([q]) => q.documentTypeName === 'blockFollow')).toHaveLength(1)

    // More feed pages introduce new authors, and revisiting a tab remounts cards.
    await blockService.checkBlockedBatch(viewer, authors.slice(20))
    await Promise.all(authors.map(id => blockService.isBlocked(id, viewer)))
    expect(blockQueries()).toHaveLength(1)
  })

  it('filters blocked authors even when they have no bloom filter', async () => {
    query.mockImplementation(async q => q.documentTypeName === 'block' ? [block(authors[0])] : [])
    const statuses = await blockService.checkBlockedBatch(viewer, authors.slice(0, 20))
    expect(statuses.get(authors[0])).toBe(true)
    expect(authors.slice(1, 20).every(id => statuses.get(id) === false)).toBe(true)
    expect(await blockService.isBlocked(authors[0], viewer)).toBe(true)
    expect(blockQueries()).toHaveLength(1)
  })

  it('reads every page before trusting negative results for a list over 100 blocks', async () => {
    query.mockImplementation(async q => {
      if (q.documentTypeName !== 'block') return []
      return q.startAfter ? [block(authors[100], 100)] : authors.slice(0, 100).map((id, i) => block(id, i))
    })
    const statuses = await blockService.checkBlockedBatch(viewer, [authors[100], authors[119]])
    expect(statuses.get(authors[100])).toBe(true)
    expect(statuses.get(authors[119])).toBe(false)
    expect(blockQueries()).toHaveLength(2)
    expect(blockQueries()[1][0].startAfter).toBe(identity(100))
    expect(getOwnBlocksFromCache(viewer)).toHaveLength(101)
  })

  it('does not cache a failed owner read as an empty block list', async () => {
    query.mockRejectedValueOnce(new Error('bad proof'))
    await expect(blockService.isBlocked(authors[0], viewer)).rejects.toThrow('bad proof')
    expect(getOwnBlocksFromCache(viewer)).toBeNull()
    query.mockResolvedValueOnce([block(authors[0])])
    expect(await blockService.isBlocked(authors[0], viewer)).toBe(true)
    expect(blockQueries()).toHaveLength(2)
  })

  it('does not trust a partial list when a later page fails', async () => {
    query.mockResolvedValueOnce(authors.slice(0, 100).map((id, i) => block(id, i)))
      .mockRejectedValueOnce(new Error('page failed'))
    await expect(blockService.checkBlockedBatch(viewer, [authors[100]])).rejects.toThrow('page failed')
    expect(getOwnBlocksFromCache(viewer)).toBeNull()
  })

  it('keeps viewer caches separate and refreshes after expiry or invalidation', async () => {
    const otherViewer = identity(249)
    query.mockImplementation(async q => q.documentTypeName === 'block' && q.where[0][2] === otherViewer
      ? [block(authors[0], 0, otherViewer)] : [])
    expect(await blockService.isBlocked(authors[0], viewer)).toBe(false)
    expect(await blockService.isBlocked(authors[0], otherViewer)).toBe(true)
    expect(blockQueries()).toHaveLength(2)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1)
    // A freshly written follows section must not extend the own-block snapshot.
    setBlockFollows(viewer, [])
    await blockService.isBlocked(authors[0], viewer)
    expect(blockQueries()).toHaveLength(3)
    invalidateBlockCache(viewer)
    await blockService.isBlocked(authors[0], viewer)
    expect(blockQueries()).toHaveLength(4)
  })

  it('does not treat a cache seeded by a mutation or block follows as a full list', async () => {
    setBlockFollows(viewer, [])
    addOwnBlock(viewer, authors[0])
    expect(getOwnBlocksFromCache(viewer)).toBeNull()
    query.mockImplementation(async q => q.documentTypeName === 'block' ? [block(authors[0]), block(authors[1], 1)] : [])
    expect(await blockService.isBlocked(authors[1], viewer)).toBe(true)
    expect(blockQueries()).toHaveLength(1)
    addOwnBlock(viewer, authors[2])
    expect(await blockService.isBlocked(authors[2], viewer)).toBe(true)
    removeOwnBlock(viewer, authors[2])
    expect(await blockService.isBlocked(authors[2], viewer)).toBe(false)
    expect(blockQueries()).toHaveLength(1)
  })

  it('continues to verify inherited blocks after the own list is cached', async () => {
    const followed = identity(248)
    setBlockFollows(viewer, [followed])
    query.mockImplementation(async q => q.documentTypeName === 'block' && q.where[0][2] === followed
      ? [block(authors[1], 0, followed)] : [])
    const statuses = await blockService.checkBlockedBatch(viewer, authors.slice(0, 20))
    expect(statuses.get(authors[0])).toBe(false)
    expect(statuses.get(authors[1])).toBe(true)
    expect(blockQueries()).toHaveLength(2)
    expect(await blockService.isBlocked(authors[1], viewer)).toBe(true)
    expect(blockQueries()).toHaveLength(2)
  })

  it('does not let a slow snapshot undo a successful unblock', async () => {
    let resolveSnapshot!: (documents: ReturnType<typeof block>[]) => void
    query.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve }))
    const pending = blockService.isBlocked(authors[0], viewer)
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    query.mockResolvedValueOnce([block(authors[0])])
    expect(await blockService.unblockUser(viewer, authors[0])).toEqual({ success: true })
    resolveSnapshot([block(authors[0])])
    expect(await pending).toBe(false)
    expect(getOwnBlocksFromCache(viewer)).toEqual([])
    // One stale snapshot, the mutation's lookup, and one shared restart.
    expect(blockQueries()).toHaveLength(3)
  })

  it('does not query blocks for logged-out or empty feeds', async () => {
    await blockService.checkBlockedBatch('', authors)
    await blockService.checkBlockedBatch(viewer, [])
    expect(query).not.toHaveBeenCalled()
  })
})

describe('block provenance', () => {
  const followed = identity(248)
  const inheritedFrom = (targets: string[]) => async (q: { documentTypeName: string; where: unknown[][] }) =>
    q.documentTypeName === 'block' && q.where[0][2] === followed
      ? targets.map((id, i) => block(id, i, followed)) : []

  it('reports an inherited-only block as not directly unblockable', async () => {
    setBlockFollows(viewer, [followed])
    query.mockImplementation(inheritedFrom([authors[0]]))
    expect(await blockService.getBlockProvenance(authors[0], viewer))
      .toEqual({ isBlocked: true, isOwnBlock: false, inheritedFrom: followed })
  })

  it('reports both sources when the target is blocked directly and by a followed list', async () => {
    setBlockFollows(viewer, [followed])
    query.mockImplementation(async q => q.documentTypeName !== 'block' ? []
      : q.where[0][2] === followed ? [block(authors[0], 0, followed)] : [block(authors[0])])
    expect(await blockService.getBlockProvenance(authors[0], viewer))
      .toEqual({ isBlocked: true, isOwnBlock: true, inheritedFrom: followed })
  })

  it('keeps a confirmed own block that is not queryable yet', async () => {
    setBlockFollows(viewer, [])
    // A block this session just broadcast; the owner query does not return it yet.
    addOwnBlock(viewer, authors[0])
    expect(await blockService.getBlockProvenance(authors[0], viewer))
      .toEqual({ isBlocked: true, isOwnBlock: true, inheritedFrom: null })
    expect(blockQueries()).toHaveLength(1)
    expect(await blockService.isBlocked(authors[0], viewer)).toBe(true)
  })

  it('never reports the viewer as blocking themself', async () => {
    expect(await blockService.getBlockProvenance(viewer, viewer))
      .toEqual({ isBlocked: false, isOwnBlock: false, inheritedFrom: null })
    expect(query).not.toHaveBeenCalled()
  })

  it('labels a batch of targets by block source with one query per source', async () => {
    setBlockFollows(viewer, [followed])
    query.mockImplementation(async q => q.documentTypeName !== 'block' ? []
      : q.where[0][2] === followed ? [block(authors[1], 1, followed), block(authors[2], 2, followed)] : [block(authors[2], 2)])
    const sources = await blockService.getBlockSourcesBatch(viewer, authors.slice(0, 4))
    expect(Object.fromEntries(sources)).toEqual({ [authors[1]]: 'inherited', [authors[2]]: 'own' })
    // The own list plus one inherited check for the followed blocker.
    expect(blockQueries()).toHaveLength(2)
  })
})
