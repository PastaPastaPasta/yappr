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

describe('failed notification sources', () => {
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

  it('count a reader that caught its own failure', async () => {
    const notificationService = await serviceWithSources()
    vi.mocked(notificationService.getReplyNotifications).mockRestore()
    const { replyService } = await import('./reply-service')
    vi.spyOn(replyService, 'getRepliesToMyContent').mockRejectedValue(new Error('DAPI unavailable'))

    const polled = await notificationService.pollNewNotifications('viewer', 1_000)
    expect(polled.failure).toEqual(new Error('DAPI unavailable'))
    expect(polled.latestTimestamp).toBe(1_000)
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
      likerCount: 2, timeless: true, createdAt: 5_000,
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
