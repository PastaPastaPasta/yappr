import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: vi.fn() } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllEnvs())

describe('posts tagged with one tag (tagAndTime)', () => {
  it('pins hashtag with == through v15, and one element of v16\'s tags with contains, ordered by $createdAt alone', async () => {
    const shapes: Record<string, unknown> = {}
    for (const topology of ['v15', 'v16', 'v17']) {
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
      shapes[topology] = (await import('./post-service')).postsTaggedQuery('dash')
    }
    expect(shapes).toEqual({
      v15: { where: [['hashtag', '==', 'dash'], ['$createdAt', '>', 0]], orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']] },
      v16: { where: [['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
      // v17 keys tagAndTime [live, tags, $createdAt]: live is pinned in where only (an orderBy
      // naming it would not be a contiguous run of the index, which Drive refuses).
      v17: { where: [['live', '==', true], ['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
    })
  })
})

describe('the post timeline (timeline)', () => {
  it('pins live == true on v17 only', async () => {
    const shapes: Record<string, unknown> = {}
    for (const topology of ['v16', 'v17']) {
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
      shapes[topology] = (await import('./document-service')).postTimelineClauses('en', 5)
    }
    expect(shapes).toEqual({
      v16: { where: [['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] },
      v17: { where: [['live', '==', true], ['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] },
    })
  })
})

describe('a reply shown as a post (replyToPost)', () => {
  it('keeps everything a private reply needs to be read and reported, the feed included', async () => {
    const { replyToPost } = await import('./post-service')
    const encrypted = { encryptedContent: new Uint8Array([1, 2]), nonce: new Uint8Array(24), keyGeneration: 3, feed: 2 }
    const post = replyToPost({
      id: 'r', author: { id: 'a' } as never, content: '', createdAt: new Date(0), likes: 0, reposts: 0, replies: 0, views: 0,
      parentId: 'p', parentOwnerId: 'o', rootPostId: 'p', rootOwnerId: 'o', ...encrypted,
    })
    expect(post).toMatchObject({ targetKind: 'reply', rootOwnerId: 'o', ...encrypted })
  })
})

describe('strict bookmarked post hydration (T-SOC-02)', () => {
  it('propagates fallback read failures rather than claiming a live target is absent', async () => {
    const { postService } = await import('./post-service')
    const query = vi.spyOn(postService, 'queryForDisplay').mockRejectedValue(new TypeError('Failed to fetch'))
    const fallback = vi.spyOn(postService, 'getMany').mockImplementation(async (_ids, options) => {
      if (options?.throwOnError) throw new TypeError('Failed to fetch')
      return []
    })
    try {
      await expect(postService.getPostsByIdsForDisplay(['saved'], { throwOnError: true })).rejects.toThrow('Failed to fetch')
      expect(fallback).toHaveBeenCalledWith(['saved'], { throwOnError: true })
      fallback.mockResolvedValue([])
      await expect(postService.getPostsByIdsForDisplay(['gone'], { throwOnError: true })).resolves.toMatchObject({ posts: [] })
    } finally {
      query.mockRestore()
      fallback.mockRestore()
    }
  })
})
