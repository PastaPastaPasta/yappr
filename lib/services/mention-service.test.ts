import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { query, createDocument } = vi.hoisted(() => ({ query: vi.fn(), createDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument } }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

beforeEach(() => {
  vi.resetModules()
  query.mockReset()
  createDocument.mockReset()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('v10 mentions (post and reply mentionedUserId)', () => {
  it('lists the mentioning posts and replies off their permanent mentionedUserAndTime indexes, merged newest first', async () => {
    query.mockImplementation(async ({ documentTypeName }: { documentTypeName: string }) => documentTypeName === 'post'
      ? [
        { $id: 'post-a', $ownerId: 'alice', $createdAt: 10, mentionedUserId: 'me' },
        { $id: 'post-b', $ownerId: 'bob', $createdAt: 30, mentionedUserId: 'me' },
      ]
      : [{ $id: 'reply-c', $ownerId: 'carol', $createdAt: 20, mentionedUserId: 'me' }])
    const { mentionService } = await import('./mention-service')
    expect(await mentionService.getPostsMentioningUser('me')).toEqual([
      { $id: 'post-b', $ownerId: 'bob', $createdAt: 30, postId: 'post-b', mentionedUserId: 'me' },
      { $id: 'reply-c', $ownerId: 'carol', $createdAt: 20, postId: 'reply-c', mentionedUserId: 'me', targetKind: 'reply' },
      { $id: 'post-a', $ownerId: 'alice', $createdAt: 10, postId: 'post-a', mentionedUserId: 'me' },
    ])
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.map(([q]) => q.documentTypeName).sort()).toEqual(['post', 'reply'])
    for (const [q] of query.mock.calls) {
      expect(q).toMatchObject({
        where: [['mentionedUserId', '==', 'me'], ['$createdAt', '>', 0]],
        orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']],
      })
      expect(q).not.toHaveProperty('timeRange')
    }
  })

  it('loads the Mentions tab from both kinds: posts by id, replies by id, authentic only, newest first', async () => {
    const { mentionService } = await import('./mention-service')
    const { postService } = await import('./post-service')
    const { replyService } = await import('./reply-service')
    const author = (id: string) => ({ id, username: '', displayName: id, avatar: '', followers: 0, following: 0, joinedAt: new Date(0) })
    const post = (id: string, owner: string, at: number) => ({ id, author: author(owner), content: id, createdAt: new Date(at), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, liked: false, reposted: false, bookmarked: false })
    const byIds = vi.spyOn(postService, 'getPostsByIdsForDisplay').mockResolvedValue({
      posts: [post('post-a', 'alice', 10), post('forged', 'mallory', 40)],
      preloaded: {},
    })
    const replies = vi.spyOn(replyService, 'getRepliesByIds').mockResolvedValue([
      { ...post('reply-c', 'carol', 20), parentId: 'post-a', parentOwnerId: 'alice', rootPostId: 'post-a' },
    ])
    const { posts } = await mentionService.loadMentioningPosts([
      { $id: 'post-a', $ownerId: 'alice', $createdAt: 10, postId: 'post-a', mentionedUserId: 'me' },
      { $id: 'reply-c', $ownerId: 'carol', $createdAt: 20, postId: 'reply-c', mentionedUserId: 'me', targetKind: 'reply' },
      // A record whose document belongs to someone else is dropped.
      { $id: 'x', $ownerId: 'alice', $createdAt: 40, postId: 'forged', mentionedUserId: 'me' },
    ])
    expect(byIds).toHaveBeenCalledWith(['post-a', 'forged'])
    expect(replies).toHaveBeenCalledWith(['reply-c'])
    expect(posts.map((p) => [p.id, p.targetKind])).toEqual([['reply-c', 'reply'], ['post-a', undefined]])
  })

  it('writes no postMention document: the doctype is gone', async () => {
    const { mentionService } = await import('./mention-service')
    expect(await mentionService.createPostMention('post', 'owner', 'someone')).toBe(false)
    expect(createDocument).not.toHaveBeenCalled()
  })
})

describe('v2 mentions (postMention documents)', () => {
  it('lists them newest first, read to the end', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v2')
    // The index walks oldest first; 150 records take two pages.
    query.mockImplementation(async ({ limit, startAfter }: { limit: number; startAfter?: string }) => {
      const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0
      return Array.from({ length: Math.max(0, Math.min(limit, 150 - first)) }, (_, i) => ({
        $id: `m${first + i}`, $ownerId: 'alice', $createdAt: first + i, postId: `p${first + i}`, mentionedUserId: 'me',
      }))
    })
    const { mentionService } = await import('./mention-service')
    const mentions = await mentionService.getPostsMentioningUser('me')
    expect(mentions).toHaveLength(150)
    expect(mentions[0].$createdAt).toBe(149)
    expect(mentions.at(-1)?.$createdAt).toBe(0)
    expect(query.mock.calls.every(([q]) => q.documentTypeName === 'postMention')).toBe(true)
  })
})
