import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryDocumentsOptions } from './sdk-helpers'

const { bundle } = vi.hoisted(() => ({ bundle: vi.fn() }))
vi.mock('./document-query-bundle', () => ({ queryDocumentBundle: bundle }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
vi.mock('./identity-batch', () => ({ loadIdentityBatch: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  bundle.mockReset().mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map(() => []))
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('notification sources', () => {
  it('reads each source newest first, so a busy source keeps its latest events', async () => {
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    for (const reader of ['getLikeNotifications', 'getRepostNotifications', 'getReplyNotifications'] as const) {
      vi.spyOn(notificationService, reader).mockResolvedValue([])
    }

    await notificationService.pollNewNotifications('viewer', 1000)

    const queries: QueryDocumentsOptions[] = bundle.mock.calls[0][0]
    expect(queries.map(query => query.documentTypeName))
      .toEqual(['follow', 'postMention', 'followRequest', 'like', 'likeReply', 'repost', 'reply'])
    // Every sibling walks the same (descending) direction, which a composite
    // bundle requires, and the per-source limit then drops the OLDEST events.
    expect(queries.map(query => query.orderBy?.[1])).toEqual(queries.map(() => ['$createdAt', 'desc']))
  })
})

describe('v10 windowed notification sources', () => {
  it('bundles the permanent sources (post and reply mentions included), reads likes per recent target, and both open windows of replies and quotes as separate queries', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const query = vi.fn().mockResolvedValue([])
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    const likes = vi.spyOn(notificationService, 'getLikeNotifications').mockResolvedValue([])

    await notificationService.pollNewNotifications('viewer', 1000)
    // Like design C: no author-wide like index, so the like reader runs its own
    // per-target fan-out instead of reading bundle results.
    expect(likes).toHaveBeenCalledWith('viewer', 1000)

    // Follows, mentions (the mentioning post's and reply's own permanent
    // indexes) and follow requests keep the $createdAt > since shape; no
    // windowed source and no like source rides the composite.
    const queries: QueryDocumentsOptions[] = bundle.mock.calls[0][0]
    expect(queries.map(query => query.documentTypeName)).toEqual(['follow', 'post', 'reply', 'followRequest'])
    for (const mention of [queries[1], queries[2]]) {
      expect(mention.where).toEqual([['mentionedUserId', '==', 'viewer'], ['$createdAt', '>', 1000]])
      expect(mention.orderBy).toEqual([['mentionedUserId', 'asc'], ['$createdAt', 'desc']])
      expect(mention.limit).toBe(100)
    }
    expect(queries.every(query => query.where?.[1]?.[1] === '>' && !('timeRange' in query))).toBe(true)

    // Two plain reads per windowed source: the current window and the previous one by its start.
    const windowed = query.mock.calls.map(([q]) => q)
    const grid = { range: 302_400, step: 302_400 }
    expect(windowed).toHaveLength(4)
    for (const [documentTypeName, field] of [['reply', 'parentOwnerId'], ['post', 'quotedPostOwnerId']]) {
      const reads = windowed.filter((q) => q.documentTypeName === documentTypeName)
      expect(reads.map((q) => q.timeRange[0].selector).sort()).toEqual(['byStart', 'newest'])
      for (const q of reads) expect(q).toMatchObject({ where: [[field, '==', 'viewer']], timeRange: [expect.objectContaining({ field: '$createdAt', grid })], limit: 100 })
    }
    for (const q of windowed) expect(q.orderBy, q.documentTypeName).toBeUndefined()
  })

  it('notifies a mentioning post by its own id, author and exact time, read after the watermark', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const query = vi.fn().mockImplementation(async ({ documentTypeName }: QueryDocumentsOptions) => documentTypeName === 'post'
      ? [{ $id: 'new', $ownerId: 'bob', $createdAt: 1_100, mentionedUserId: 'viewer' }]
      : [])
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { notificationService } = await import('./notification-service')

    expect(await notificationService.getNewMentions('viewer', 1_000)).toEqual([
      { id: 'mention-new', type: 'mention', fromUserId: 'bob', postId: 'new', createdAt: 1_100 },
    ])
    // The permanent post and reply mentionedUserAndTime walks, filtered by the node.
    expect(query.mock.calls.map(([q]) => q.documentTypeName)).toEqual(['post', 'reply'])
    for (const [q] of query.mock.calls) {
      expect(q).toMatchObject({ where: [['mentionedUserId', '==', 'viewer'], ['$createdAt', '>', 1_000]] })
      expect(q).not.toHaveProperty('timeRange')
    }
  })

  it('notifies a mentioning reply as a mention of the reply, carrying its thread for the link', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const { notificationService } = await import('./notification-service')
    const bs58 = (await import('bs58')).default
    const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
    const [ROOT, PARENT, REPLY, POST, BOB, CAROL, ME] = [1, 2, 3, 4, 5, 6, 7].map(id)
    const raw = await notificationService.getNewMentions(ME, 1_000, [
      [{ $id: POST, $ownerId: CAROL, $createdAt: 1_200, mentionedUserId: ME }],
      [{ $id: REPLY, $ownerId: BOB, $createdAt: 1_100, content: 'hey @me', rootPostId: ROOT, replyToReplyId: PARENT, parentOwnerId: CAROL, mentionedUserId: ME, sensitive: true }],
    ])
    expect(raw).toEqual([
      { id: `mention-${POST}`, type: 'mention', fromUserId: CAROL, postId: POST, createdAt: 1_200 },
      {
        id: `mention-${REPLY}`, type: 'mention', fromUserId: BOB, postId: REPLY, createdAt: 1_100,
        parentId: PARENT, rootPostId: ROOT, replyContent: 'hey @me', sensitive: true,
      },
    ])
  })

  it('renders a reply mention from the reply itself, linked to the reply in its thread', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const query = vi.fn().mockResolvedValue([])
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map(), profiles: [], avatars: new Map() } as unknown as Awaited<ReturnType<typeof loadIdentityBatch>>)
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getLikeNotifications').mockResolvedValue([])
    const bs58 = (await import('bs58')).default
    const ROOT = bs58.encode(new Uint8Array(32).fill(1))
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map((q) => q.documentTypeName === 'reply'
      ? [{ $id: 'reply-1', $ownerId: 'bob', $createdAt: 1_100, content: 'hi @viewer', rootPostId: ROOT, mentionedUserId: 'viewer' }]
      : []))

    const { notifications } = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(notifications).toHaveLength(1)
    // A post carrying rootPostId links to itself (app/notifications getNotificationUrl).
    expect(notifications[0]).toMatchObject({
      id: 'mention-reply-1', type: 'mention',
      post: { id: 'reply-1', targetKind: 'reply', content: 'hi @viewer', rootPostId: ROOT, parentId: ROOT },
    })
    // Pre-fetched: no by-id re-read of the reply (only the four window reads ran).
    expect(query.mock.calls.every(([q]) => 'timeRange' in q)).toBe(true)
  })

  it('notifies a bare quote as a repost of the target and a quote with text as a quote', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const { notificationService } = await import('./notification-service')
    const bs58 = (await import('bs58')).default
    const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
    const [MY_POST, MY_REPLY, BARE, QUOTE, OTHER, ALICE, BOB, CAROL, ME] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id)
    const raw = await notificationService.getRepostNotifications(ME, 0, [
      { $id: BARE, $ownerId: ALICE, $createdAt: 3, quotedPostId: MY_POST, quotedPostOwnerId: ME },
      { $id: QUOTE, $ownerId: BOB, $createdAt: 2, content: 'so true', quotedReplyId: MY_REPLY, quotedPostOwnerId: ME },
      { $id: OTHER, $ownerId: CAROL, $createdAt: 1, content: 'no quote at all' },
    ])
    expect(raw).toEqual([
      { id: `repost-${BARE}`, type: 'repost', fromUserId: ALICE, postId: MY_POST, targetKind: 'post', createdAt: 3 },
      { id: `quote-${QUOTE}`, type: 'quote', fromUserId: BOB, postId: QUOTE, targetKind: 'reply', createdAt: 2 },
    ])
  })
})
