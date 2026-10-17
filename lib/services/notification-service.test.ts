import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryDocumentsOptions } from './sdk-helpers'
import type { Notification } from '@/lib/types'

const { bundle, checkBlockedBatch } = vi.hoisted(() => ({ bundle: vi.fn(), checkBlockedBatch: vi.fn() }))
vi.mock('./document-query-bundle', () => ({ queryDocumentBundle: bundle }))
vi.mock('./block-service', () => ({ blockService: { checkBlockedBatch } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
vi.mock('./identity-batch', () => ({ loadIdentityBatch: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  bundle.mockReset().mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map(() => []))
  checkBlockedBatch.mockReset().mockImplementation(async (_viewer: string, ids: string[]) => new Map(ids.map((id) => [id, false])))
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The first test pays the cold import of the service graph, slow on a loaded runner.
describe('notification sources', { timeout: 20_000 }, () => {
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

describe('failed notification sources', { timeout: 20_000 }, () => {
  async function serviceWithSources() {
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    for (const reader of ['getLikeNotifications', 'getRepostNotifications', 'getReplyNotifications'] as const) {
      vi.spyOn(notificationService, reader).mockResolvedValue([])
    }
    return notificationService
  }

  it('say so, and keep the watermark, when a source failed soft to nothing', async () => {
    const quorum = new Error('invalid quorum: Quorum not found in cache for hash: 00ab')
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[], _tolerate: boolean, failed?: (error: unknown) => void) => {
      failed?.(quorum)
      return queries.map(() => [])
    })
    const notificationService = await serviceWithSources()

    const initial = await notificationService.getInitialNotifications('viewer')
    expect(initial.notifications).toEqual([])
    expect(initial.failure).toBe(quorum)
    // Not "now": the next poll reads the whole 7 days again, instead of only what is newer.
    expect(initial.latestTimestamp).toBeLessThan(Date.now() - 6 * 24 * 60 * 60 * 1000)

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(polled.failure).toBe(quorum)
    expect(polled.latestTimestamp).toBe(1_000)
  })

  it.each(['v10', 'v11'])('%s: a reply window read that failed holds the watermark, though another source found something newer', async (topology) => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
    // The reply source's cache wires listeners on window.
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const quorum = new Error('invalid quorum: Quorum not found in cache for hash: 00ab')
    // The real reply reader (readNotificationWindow over the plain query) and quote reader; only the reply windows fail.
    const query = vi.fn().mockImplementation(async ({ documentTypeName }: QueryDocumentsOptions) => {
      if (documentTypeName === 'reply') throw quorum
      return []
    })
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map(), profiles: [], avatars: new Map() } as unknown as Awaited<ReturnType<typeof loadIdentityBatch>>)
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map((q) => q.documentTypeName === 'follow'
      ? [{ $id: 'follow-1', $ownerId: 'bob', $createdAt: 1_500, followingId: 'viewer' }]
      : []))
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getLikeNotifications').mockResolvedValue([])

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(polled.notifications.map((n) => n.id)).toEqual(['follow-1'])
    expect(polled.failure).toBe(quorum)
    // Not the follow's 1_500: the replies between 1_000 and 1_500 are read again next poll.
    expect(polled.latestTimestamp).toBe(1_000)
  })

  it('count a failed read of the blogs the user follows', async () => {
    const notificationService = await serviceWithSources()
    vi.mocked(notificationService.getBlogPostNotifications).mockRestore()
    const offline = new Error('DAPI unavailable')
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query: vi.fn().mockRejectedValue(offline) } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(polled.failure).toBe(offline)
    expect(polled.latestTimestamp).toBe(1_000)
  })

  it('count a followed blog whose posts could not be read', async () => {
    const notificationService = await serviceWithSources()
    vi.mocked(notificationService.getBlogPostNotifications).mockRestore()
    const { blogFollowService } = await import('./blog-follow-service')
    vi.spyOn(blogFollowService, 'getFollowedBlogIds').mockResolvedValue(['blog-1'])
    const offline = new Error('one unavailable')
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[], _tolerate: boolean, failed?: (error: unknown) => void) => {
      if (queries.some((q) => q.documentTypeName === 'blogPost')) failed?.(offline)
      return queries.map(() => [])
    })

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(polled.failure).toBe(offline)
    expect(polled.latestTimestamp).toBe(1_000)
  })

  it('keep each fetch its own: one failing at the same time does not make another look failed', async () => {
    const quorum = new Error('invalid quorum')
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[], _tolerate: boolean, failed?: (error: unknown) => void) => {
      if (queries[0].where?.[0]?.[2] === 'old-account') failed?.(quorum)
      return queries.map(() => [])
    })
    const notificationService = await serviceWithSources()

    const now = Date.now()
    const [old, current] = await Promise.all([
      notificationService.pollNewNotifications('old-account', 1_000),
      notificationService.getInitialNotifications('new-account'),
    ])
    expect(old.failure).toBe(quorum)
    expect(current.failure).toBeUndefined()
    expect(current.latestTimestamp).toBeGreaterThanOrEqual(now)
  })

  it('answer as before when every source answered', async () => {
    const notificationService = await serviceWithSources()
    const now = Date.now()
    const initial = await notificationService.getInitialNotifications('viewer')
    expect(initial.failure).toBeUndefined()
    expect(initial.latestTimestamp).toBeGreaterThanOrEqual(now)
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

  it('v15: bundles the mention sources as contains reads of the user\'s element, and notifies each person a post names', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v15')
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query: vi.fn().mockResolvedValue([]) } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getLikeNotifications').mockResolvedValue([])

    await notificationService.pollNewNotifications('viewer', 1000)
    const queries: QueryDocumentsOptions[] = bundle.mock.calls[0][0]
    expect(queries.map(query => query.documentTypeName)).toEqual(['follow', 'post', 'reply', 'followRequest'])
    for (const mention of [queries[1], queries[2]]) {
      expect(mention.where).toEqual([['mentionedUserIds', 'contains', 'viewer'], ['$createdAt', '>', 1000]])
      expect(mention.orderBy).toEqual([['$createdAt', 'desc']])
      expect(mention.limit).toBe(100)
    }

    // One post naming two people: each one's read returns it, so each gets one notification.
    const post = { $id: 'p1', $ownerId: 'carol', $createdAt: 1_100, mentionedUserIds: ['viewer', 'dave'] }
    for (const recipient of ['viewer', 'dave']) {
      expect(await notificationService.getNewMentions(recipient, 1_000, [[post], []])).toEqual([
        { id: 'mention-p1', type: 'mention', fromUserId: 'carol', postId: 'p1', createdAt: 1_100 },
      ])
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

describe('v11 timeless like notifications', () => {
  const store = new Map<string, string>()
  const likes = { counts: vi.fn(), likers: vi.fn() }

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v11')
    store.clear()
    // readScoped needs a window; the reply source's cache wires listeners on it.
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) })
    vi.doMock('./like-service', () => ({ likeService: { getRecentTargetLikeCounts: likes.counts, getLikersOf: likes.likers } }))
    likes.counts.mockReset()
    likes.likers.mockReset()
  })
  afterEach(() => {
    vi.doUnmock('./like-service')
    vi.unstubAllGlobals()
  })

  /** Each poll's per-kind counts and likers (only the targets asked for come back). */
  function chainSays(posts: Record<string, string[]>, replies: Record<string, string[]> = {}) {
    const of = (kind: string) => (kind === 'post' ? posts : replies)
    likes.counts.mockImplementation(async (_user: string, kind: string) => new Map(Object.entries(of(kind)).map(([target, likers]) => [target, { count: likers.length, createdAtMs: 1_000 }])))
    likes.likers.mockImplementation(async (_user: string, targets: string[], kind: string) => new Map(targets.map((target) => [target, { likers: of(kind)[target], complete: true }])))
  }

  it('baselines silently on the first poll, then aggregates new likers into one undated notification per target that does not move the watermark', async () => {
    const { notificationService } = await import('./notification-service')

    chainSays({ P1: ['alice'] }, { R1: ['bob'] })
    expect(await notificationService.getLikeNotifications('me', 0)).toEqual([])
    expect(likes.likers).toHaveBeenCalledWith('me', ['P1'], 'post')
    expect(likes.likers).toHaveBeenCalledWith('me', ['R1'], 'reply')
    expect([...store.keys()]).toEqual(['yappr_like_notifications:me'])

    likes.likers.mockClear()
    chainSays({ P1: ['alice', 'carol', 'dave', 'me'] }, { R1: ['bob'] })
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const raw = await notificationService.getLikeNotifications('me', 0)

    // Only the moved target is re-read.
    expect(likes.likers.mock.calls).toEqual([['me', ['P1'], 'post']])
    expect(raw).toEqual([{
      id: 'like:post:P1:5000', type: 'like', fromUserId: 'carol', postId: 'P1', targetKind: 'post',
      likerCount: 2, likers: ['carol', 'dave'], timeless: true, createdAt: 5_000,
    }])
    // Retained, not re-created: the next diff finds nothing new and returns the same batch.
    expect(await notificationService.getLikeNotifications('me', 0)).toEqual(raw)
  })

  it('announces nothing new when the snapshot cannot be saved, so a full storage does not repeat a batch every poll', async () => {
    const { notificationService } = await import('./notification-service')
    chainSays({ P1: ['alice'] })
    await notificationService.getLikeNotifications('me', 0)

    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: () => { throw new Error('QuotaExceededError') } })
    chainSays({ P1: ['alice', 'carol'] })
    expect(await notificationService.getLikeNotifications('me', 0)).toEqual([])
  })

  it('keeps a snapshot another tab saved during the diff and drops its own', async () => {
    const { notificationService } = await import('./notification-service')
    chainSays({ P1: ['alice'] })
    await notificationService.getLikeNotifications('me', 0)
    const saved = store.get('yappr_like_notifications:me')

    const theirs = JSON.stringify({ ...JSON.parse(saved ?? '{}'), horizons: { post: 2_000 } })
    chainSays({ P1: ['alice', 'carol'] })
    // The other tab writes while this one reads the chain.
    likes.likers.mockImplementationOnce(async () => {
      store.set('yappr_like_notifications:me', theirs)
      return new Map([['P1', { likers: ['alice', 'carol'], complete: true }]])
    })
    expect(await notificationService.getLikeNotifications('me', 0)).toEqual([])
    expect(store.get('yappr_like_notifications:me')).toBe(theirs)
  })

  it('keeps the batch for the next initial fetch and leaves the watermark to timed sources', async () => {
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map(), profiles: [], avatars: new Map() } as unknown as Awaited<ReturnType<typeof loadIdentityBatch>>)
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query: vi.fn().mockResolvedValue([]) } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])

    chainSays({ P1: ['alice'] })
    await notificationService.pollNewNotifications('me', 1_000)
    chainSays({ P1: ['alice', 'carol'] })
    const polled = await notificationService.pollNewNotifications('me', 1_000)

    expect(polled.notifications.map(({ id, type, likerCount, timeless }) => ({ id, type, likerCount, timeless })))
      .toEqual([{ id: expect.stringMatching(/^like:post:P1:\d+$/), type: 'like', likerCount: 1, timeless: true }])
    // The like's time is the device clock: the watermark stays where it was.
    expect(polled.latestTimestamp).toBe(1_000)

    // A completed poll delivered it: the next poll does not repeat it, an initial fetch does.
    chainSays({ P1: ['alice', 'carol'] })
    expect((await notificationService.pollNewNotifications('me', 1_000)).notifications).toEqual([])
    const initial = await notificationService.getInitialNotifications('me')
    expect(initial.notifications.map(({ id }) => id)).toEqual(polled.notifications.map(({ id }) => id))
  })

  it('drops only the blocked likers from a batch, and the batch only when every liker is blocked', async () => {
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map(), profiles: [], avatars: new Map() } as unknown as Awaited<ReturnType<typeof loadIdentityBatch>>)
    const { getEvoSdk } = await import('./evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { query: vi.fn().mockResolvedValue([]) } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    checkBlockedBatch.mockImplementation(async (_viewer: string, ids: string[]) => new Map(ids.map((id) => [id, id === 'troll'])))

    chainSays({ P1: ['alice'], P2: ['alice'] })
    await notificationService.pollNewNotifications('me', 1_000)
    // The blocked liker comes first on P1; P2's only new liker is blocked.
    chainSays({ P1: ['alice', 'troll', 'carol', 'dave'], P2: ['alice', 'troll'] })
    const polled = await notificationService.pollNewNotifications('me', 1_000)

    // P1 keeps carol and dave; P2 had no one else and is gone.
    expect(polled.notifications.map(({ id, from, likerCount }) => ({ id, from: from.id, likerCount })))
      .toEqual([{ id: expect.stringMatching(/^like:post:P1:/), from: 'carol', likerCount: 2 }])
  })

  it('skips a kind whose reads fail and retries it next poll, without losing its baseline', async () => {
    const { notificationService } = await import('./notification-service')
    chainSays({ P1: ['alice'] })
    await notificationService.getLikeNotifications('me', 0)

    likes.counts.mockRejectedValue(new Error('DAPI unavailable'))
    expect(await notificationService.getLikeNotifications('me', 0)).toEqual([])

    chainSays({ P1: ['alice', 'erin'] })
    expect((await notificationService.getLikeNotifications('me', 0)).map(({ fromUserId }) => fromUserId)).toEqual(['erin'])
  })
})

describe('v12 timeless like notifications, through the like service (counter author index)', () => {
  const store = new Map<string, string>()
  /** Per kind, my recent targets (newest first) and who likes each. */
  const chain: Record<'post' | 'reply', Map<string, string[]>> = { post: new Map(), reply: new Map() }
  const sdk = { documents: { composite: vi.fn(), query: vi.fn() } }
  type Query = { documentTypeName: string; where: [string, string, unknown][]; orderBy?: unknown[]; limit: number }

  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v12')
    store.clear()
    chain.post = new Map()
    chain.reply = new Map()
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) })
    vi.doMock('./state-transition-service', () => ({ stateTransitionService: {} }))
    sdk.documents.composite.mockReset().mockImplementation(async ({ documentType }: { documentType: 'post' | 'reply' }) => {
      const targets = [...chain[documentType]]
      return {
        pageDocuments: targets.map(([target], i) => ({ $id: target, $ownerId: 'me', $createdAt: 10_000 - i })),
        // Preallocated: every target has a counter, zero when unliked.
        subResults: [{ kind: 'counts', counts: new Map(targets.map(([target, likers]) => [target, BigInt(likers.length)])) }],
      }
    })
    sdk.documents.query.mockReset().mockImplementation(async ({ documentTypeName, where, limit }: Query) => {
      const [[field, , target], after] = where
      if (field !== 'postId' && field !== 'replyId') throw new Error(`unexpected like read on ${field}`)
      const kind = documentTypeName === 'like' ? 'post' : 'reply'
      return (chain[kind].get(target as string) ?? [])
        .filter((liker) => !after || liker > String(after[2]))
        .sort()
        .slice(0, limit)
        .map((liker) => ({ $id: `${liker}-${String(target)}`, $ownerId: liker, [field]: target }))
    })
    // The like service imports the SDK module lazily, once per read, and a
    // poll reads both kinds at once. Observed here (vitest 3): with the module
    // mocked, one of the two concurrent `import()`s of it got the real module
    // anyway, even after a warm-up import. Stubbing the real singleton holds
    // whichever instance a read gets.
    vi.doUnmock('./evo-sdk-service')
    const { evoSdkService } = await import('./evo-sdk-service')
    vi.spyOn(evoSdkService, 'getSdk').mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof evoSdkService.getSdk>>)
  })
  afterEach(() => {
    vi.doUnmock('./state-transition-service')
    // Restore the file's module mock for anything that runs after this block.
    vi.doMock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
  })

  const likerReads = () => sdk.documents.query.mock.calls.map(([query]) => query as Query)
  const poll = async (nowMs: number) => {
    sdk.documents.query.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(nowMs)
    const { notificationService } = await import('./notification-service')
    return (await notificationService.getLikeNotifications('me', 0)).map(({ id, fromUserId, likerCount }) => ({ id, fromUserId, likerCount }))
  }

  it('reads only the moved targets on byPost/byReply, announces new likers, stays silent on a fall, and misses a swap until the count moves', async () => {
    chain.post = new Map([['P1', ['alice']], ['P2', ['bob']], ['P3', []]])
    chain.reply = new Map([['R1', ['bob']]])

    // First poll: a silent baseline, one target read per liked target, the zero-count P3 never read.
    expect(await poll(1_000)).toEqual([])
    expect(likerReads()).toEqual([
      { dataContractId: expect.any(String), documentTypeName: 'like', where: [['postId', '==', 'P1']], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 },
      { dataContractId: expect.any(String), documentTypeName: 'like', where: [['postId', '==', 'P2']], orderBy: [['postId', 'asc'], ['$ownerId', 'asc']], limit: 100 },
      { dataContractId: expect.any(String), documentTypeName: 'likeReply', where: [['replyId', '==', 'R1']], orderBy: [['replyId', 'asc'], ['$ownerId', 'asc']], limit: 100 },
    ])
    expect(sdk.documents.composite).toHaveBeenCalledTimes(2)

    // P1 and R1 gain likers: only those are re-read.
    chain.post.set('P1', ['alice', 'carol'])
    chain.reply.set('R1', ['bob', 'dave'])
    expect(await poll(2_000)).toEqual(expect.arrayContaining([
      { id: 'like:post:P1:2000', fromUserId: 'carol', likerCount: 1 },
      { id: 'like:reply:R1:2000', fromUserId: 'dave', likerCount: 1 },
    ]))
    expect(likerReads().map(({ where }) => where[0][2])).toEqual(['P1', 'R1'])

    // An unlike: the fall is re-read, and nothing is announced.
    chain.post.set('P1', ['alice'])
    const afterFall = await poll(3_000)
    expect(afterFall.map(({ id }) => id).sort()).toEqual(['like:post:P1:2000', 'like:reply:R1:2000'])
    expect(likerReads().map(({ where }) => where[0][2])).toEqual(['P1'])

    // A swap between polls (bob unlikes, erin likes): the count holds, nothing is read, erin is not announced yet.
    chain.post.set('P2', ['erin'])
    await poll(4_000)
    expect(likerReads()).toEqual([])

    // The count moves again: erin is announced late, with frank.
    chain.post.set('P2', ['erin', 'frank'])
    expect(await poll(5_000)).toContainEqual({ id: 'like:post:P2:5000', fromUserId: 'erin', likerCount: 2 })
    expect(likerReads().map(({ where }) => where[0][2])).toEqual(['P2'])
  })

  it('announces the targets that read, and a target whose read failed once on the next poll, never twice', async () => {
    chain.post = new Map([['P1', ['alice']], ['P2', ['bob']]])
    expect(await poll(1_000)).toEqual([])

    chain.post.set('P1', ['alice', 'carol'])
    chain.post.set('P2', ['bob', 'dave'])
    const read = sdk.documents.query.getMockImplementation()
    sdk.documents.query.mockImplementation(async (query: Query) => {
      if (query.where[0][2] === 'P2') throw new Error('DAPI unavailable')
      return read?.(query)
    })
    // P2's read failed: P1 is still announced, P2 waits.
    expect(await poll(2_000)).toEqual([{ id: 'like:post:P1:2000', fromUserId: 'carol', likerCount: 1 }])

    if (read) sdk.documents.query.mockImplementation(read)
    // P2 kept its known likers and count, so it is read again and dave announced once.
    expect(await poll(3_000)).toEqual([
      { id: 'like:post:P1:2000', fromUserId: 'carol', likerCount: 1 },
      { id: 'like:post:P2:3000', fromUserId: 'dave', likerCount: 1 },
    ])
    expect(likerReads().map(({ where }) => where[0][2])).toEqual(['P2'])
    expect((await poll(4_000)).map(({ id }) => id)).toEqual(['like:post:P1:2000', 'like:post:P2:3000'])
    expect(likerReads()).toEqual([])
  })

  it('carries a snapshot stored on v11 over without a fresh baseline', async () => {
    store.set('yappr_like_notifications:me', JSON.stringify({
      v: 1, baselined: ['post', 'reply'], horizons: { post: 9_000, reply: 9_000 },
      targets: { 'post:P1': { count: 1, likers: ['alice'] } }, batches: [],
    }))
    chain.post = new Map([['P1', ['alice', 'carol']]])

    expect(await poll(1_000)).toEqual([{ id: 'like:post:P1:1000', fromUserId: 'carol', likerCount: 1 }])
  })
})

describe('blog comment notifications', () => {
  it('skips comments on a post its author has since deleted (a v7 tombstone)', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    const { notificationService } = await import('./notification-service')
    const { blogCommentService } = await import('./blog-comment-service')
    const { blogPostService } = await import('./blog-post-service')
    const comment = (id: string, blogPostId: string) => ({ id, ownerId: 'reader', blogPostId, content: 'hi', createdAt: new Date(5) })
    vi.spyOn(blogCommentService, 'getCommentsOnMyPosts').mockResolvedValue([comment('c1', 'live'), comment('c2', 'gone')])
    vi.spyOn(blogPostService, 'getMany').mockResolvedValue([
      { id: 'live', blogId: 'b', ownerId: 'me', title: 'Live', slug: 'live', createdAt: new Date(1), content: [] },
      { id: 'gone', blogId: 'b', ownerId: 'me', title: '', slug: 'gone', createdAt: new Date(1), content: [], deleted: true },
    ])
    const notifications = await notificationService.getBlogCommentNotifications('me', 0)
    expect(notifications.map((n) => n.postId)).toEqual(['live'])
  })
})

describe('blocked actors', () => {
  async function serviceWithFollowsFrom(...followers: string[]) {
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map(), profiles: [], avatars: new Map() } as unknown as Awaited<ReturnType<typeof loadIdentityBatch>>)
    bundle.mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map((q) => q.documentTypeName === 'follow'
      ? followers.map((owner, index) => ({ $id: `follow-${owner}`, $ownerId: owner, $createdAt: 1_500 + index, followingId: 'viewer' }))
      : []))
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    for (const reader of ['getLikeNotifications', 'getRepostNotifications', 'getReplyNotifications'] as const) {
      vi.spyOn(notificationService, reader).mockResolvedValue([])
    }
    return notificationService
  }
  const blocking = (...blocked: string[]) => async (_viewer: string, ids: string[]) =>
    new Map(ids.map((id) => [id, blocked.includes(id)]))

  it('drops a blocked actor from the initial fetch, with one lookup for the distinct actors', async () => {
    checkBlockedBatch.mockImplementation(blocking('bob'))
    const notificationService = await serviceWithFollowsFrom('bob', 'carol')

    const { notifications } = await notificationService.getInitialNotifications('viewer')

    expect(notifications.map((n) => n.from.id)).toEqual(['carol'])
    expect(checkBlockedBatch).toHaveBeenCalledTimes(1)
    expect(checkBlockedBatch).toHaveBeenCalledWith('viewer', expect.arrayContaining(['bob', 'carol']))
  })

  it('drops a blocked actor from a poll, and still moves the watermark past them', async () => {
    checkBlockedBatch.mockImplementation(blocking('bob'))
    const notificationService = await serviceWithFollowsFrom('bob')

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)

    expect(polled.notifications).toEqual([])
    expect(polled.latestTimestamp).toBe(1_500)
  })

  it('honours a block inherited from a followed block list (the batch lookup says blocked)', async () => {
    // checkBlockedBatch folds own blocks and followed lists into one answer.
    checkBlockedBatch.mockImplementation(blocking('listed'))
    const notificationService = await serviceWithFollowsFrom('listed', 'carol')

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)

    expect(polled.notifications.map((n) => n.from.id)).toEqual(['carol'])
  })

  it('keeps the notifications, and warns, when the block lookup fails', async () => {
    const { logger } = await import('@/lib/logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    checkBlockedBatch.mockRejectedValue(new Error('blocks unavailable'))
    const notificationService = await serviceWithFollowsFrom('bob', 'carol')

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)

    expect(polled.notifications.map((n) => n.from.id).sort()).toEqual(['bob', 'carol'])
    expect(polled.failure).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('finds which held notifications are blocked now, every liker included, and fails soft', async () => {
    const { notificationService } = await import('./notification-service')
    const user = (id: string) => ({ id }) as Notification['from']
    const held = [
      { id: 'f', type: 'follow', from: user('carol'), createdAt: new Date(1), read: false },
      { id: 'l', type: 'like', from: user('alice'), likers: [user('alice'), user('listed')], likerCount: 2, createdAt: new Date(1), read: false },
    ] as Notification[]
    checkBlockedBatch.mockImplementation(blocking('listed'))
    expect(await notificationService.blockedAmongHeld('viewer', held)).toEqual(new Set(['listed']))
    expect(checkBlockedBatch).toHaveBeenCalledWith('viewer', ['carol', 'alice', 'listed'])

    checkBlockedBatch.mockRejectedValue(new Error('blocks unavailable'))
    expect(await notificationService.blockedAmongHeld('viewer', held)).toBeNull()
  })

  it('looks nothing up when there are no notifications', async () => {
    const notificationService = await serviceWithFollowsFrom()

    await notificationService.pollNewNotifications('viewer', 1_000)

    expect(checkBlockedBatch).not.toHaveBeenCalled()
  })

  it('falls back to the generated local avatar, never a third-party URL', async () => {
    const notificationService = await serviceWithFollowsFrom('bob')

    const { notifications } = await notificationService.pollNewNotifications('viewer', 1_000)

    expect(notifications[0].from.avatar).toMatch(/^data:image\//)
    expect(notifications[0].from.avatar).not.toContain('dicebear.com')
  })
})

describe('store notifications', () => {
  async function serviceWithStoreEvents(topology: string, events: unknown[]) {
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology)
    const { notificationService } = await import('./notification-service')
    const { storeNotificationService } = await import('./store-notification-service')
    const { loadIdentityBatch } = await import('./identity-batch')
    vi.mocked(loadIdentityBatch).mockResolvedValue({ usernames: new Map([['seller', 'shop']]), profiles: [], avatars: new Map() } as never)
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    for (const reader of ['getLikeNotifications', 'getRepostNotifications', 'getReplyNotifications'] as const) {
      vi.spyOn(notificationService, reader).mockResolvedValue([])
    }
    const read = vi.spyOn(storeNotificationService, 'getNotifications').mockResolvedValue(events as never)
    return { notificationService, read }
  }

  it('lists a store event with its detail and moves the watermark to it', async () => {
    const shipped = { id: 'orderStatus-u1', type: 'orderStatus', fromUserId: 'seller', createdAt: 5_000, store: { status: 'shipped' } }
    const { notificationService, read } = await serviceWithStoreEvents('v9', [shipped])

    const result = await notificationService.pollNewNotifications('buyer', 1_000)

    expect(read).toHaveBeenCalledWith('buyer', 1_000, expect.any(Function))
    expect(result.latestTimestamp).toBe(5_000)
    expect(result.notifications).toMatchObject([
      { id: 'orderStatus-u1', type: 'orderStatus', from: { id: 'seller', username: 'shop' }, store: { status: 'shipped' }, post: undefined },
    ])
  })

  it('reads none before storefront v6, which has no buyer feed', async () => {
    const { notificationService, read } = await serviceWithStoreEvents('v5', [])
    await notificationService.pollNewNotifications('buyer', 1_000)
    expect(read).not.toHaveBeenCalled()
  })
})
