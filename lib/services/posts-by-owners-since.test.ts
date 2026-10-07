/**
 * The Following feed's "new posts" check: one `$ownerId in [...]` query per
 * 100 followed accounts (Platform caps `in` at 100), each read to the end,
 * merged newest first with the limit applied after the merge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
import { newestDistinctDocuments, queryPostsByOwnersSince } from './document-service'

type PostQuery = { where: [string, string, unknown][]; orderBy: unknown; limit: number; startAfter?: string }

const owner = (n: number) => `owner-${String(n).padStart(3, '0')}`
/** Each owner posted twice after the cutoff; later owners posted later. */
const postsOf = (o: string) => {
  const n = Number(o.slice(6))
  return [
    { $id: `${o}-a`, $ownerId: o, $createdAt: 10_000 + n * 10 },
    { $id: `${o}-b`, $ownerId: o, $createdAt: 10_000 + n * 10 + 5 },
  ]
}

/** Serves a query over its `in` owners in owner order, a page after `startAfter`. */
function serve({ where, limit, startAfter }: PostQuery) {
  const owners = (where.find(([field]) => field === '$ownerId')?.[2] ?? []) as string[]
  const all = [...owners].sort().flatMap(postsOf)
  const from = startAfter ? all.findIndex(doc => doc.$id === startAfter) + 1 : 0
  return new Map(all.slice(from, from + limit).map(doc => [doc.$id, doc]))
}

beforeEach(() => {
  query.mockReset().mockImplementation(async (q: PostQuery) => serve(q))
})

describe('queryPostsByOwnersSince', () => {
  it('splits 250 followed accounts into in-clauses of at most 100', async () => {
    const owners = Array.from({ length: 250 }, (_, i) => owner(i))
    await queryPostsByOwnersSince(owners, 5_000, 50, 'contract')

    const inLists = query.mock.calls.map(([q]) => (q as PostQuery).where[0][2] as string[])
    expect(inLists.every(list => list.length <= 100)).toBe(true)
    expect(new Set(inLists.flat())).toEqual(new Set(owners))
    for (const [q] of query.mock.calls) {
      expect((q as PostQuery).where[1]).toEqual(['$createdAt', '>', 5_000])
    }
  })

  it('keeps the newest posts of high-id owners instead of the first rows in owner order', async () => {
    const owners = Array.from({ length: 250 }, (_, i) => owner(i))
    const { posts, complete } = await queryPostsByOwnersSince(owners, 5_000, 50, 'contract')

    expect(complete).toBe(true)
    expect(posts).toHaveLength(50)
    // The 50 newest are the last 25 owners' two posts each, newest first.
    expect(posts[0].$id).toBe('owner-249-b')
    expect(posts.at(-1)?.$id).toBe('owner-225-a')
    const times = posts.map(post => post.$createdAt as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('pages a batch past its first 100 rows until an empty page', async () => {
    const owners = Array.from({ length: 80 }, (_, i) => owner(i))
    const { posts } = await queryPostsByOwnersSince(owners, 5_000, 500, 'contract')
    expect(posts).toHaveLength(160)
    // 100 + 60 + the empty page that proves the end.
    expect(query).toHaveBeenCalledTimes(3)
    expect((query.mock.calls[1][0] as PostQuery).startAfter).toBe('owner-049-b')
  })

  it('keeps the first page when a continuation fails, and still fails a batch that read nothing', async () => {
    const owners = Array.from({ length: 80 }, (_, i) => owner(i))
    query.mockImplementation(async (q: PostQuery) => {
      if (q.startAfter) throw new Error('continuation refused')
      return serve(q)
    })
    const partial = await queryPostsByOwnersSince(owners, 5_000, 500, 'contract')
    expect(partial.posts).toHaveLength(100)
    // The caller must not treat the scan as covering everything up to its newest post.
    expect(partial.complete).toBe(false)

    query.mockRejectedValue(new Error('offline'))
    await expect(queryPostsByOwnersSince(owners, 5_000, 500, 'contract')).rejects.toThrow('offline')
  })

  it('reports a batch capped at 1000 posts as incomplete', async () => {
    // One owner with 1,200 posts after the cutoff.
    const crowded = Array.from({ length: 1200 }, (_, i) => ({ $id: `c${String(i).padStart(4, '0')}`, $ownerId: owner(0), $createdAt: 10_000 + i }))
    query.mockImplementation(async ({ limit, startAfter }: PostQuery) => {
      const from = startAfter ? crowded.findIndex(doc => doc.$id === startAfter) + 1 : 0
      return new Map(crowded.slice(from, from + limit).map(doc => [doc.$id, doc]))
    })
    const result = await queryPostsByOwnersSince([owner(0)], 5_000, 50, 'contract')
    expect(result.complete).toBe(false)
    expect(result.posts).toHaveLength(50)
  })

  it('de-duplicates repeated owners and makes no query without any', async () => {
    expect(await queryPostsByOwnersSince([], 0)).toEqual({ posts: [], complete: true })
    expect(query).not.toHaveBeenCalled()
    const { posts } = await queryPostsByOwnersSince([owner(1), owner(1), ''], 0, 50, 'contract')
    expect(posts.map(post => post.$id)).toEqual(['owner-001-b', 'owner-001-a'])
    expect((query.mock.calls[0][0] as PostQuery).where[0][2]).toEqual([owner(1)])
  })
})

describe('newestDistinctDocuments', () => {
  it('drops repeated ids, sorts newest first and applies the limit last', () => {
    const docs = [
      { $id: 'a', $createdAt: 1 },
      { $id: 'b', $createdAt: 3 },
      { $id: 'a', $createdAt: 1 },
      { $id: 'c', $createdAt: 2 },
    ]
    expect(newestDistinctDocuments(docs, 2).map(doc => doc.$id)).toEqual(['b', 'c'])
  })
})
