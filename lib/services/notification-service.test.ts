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

describe('v10 repost and quote notifications', () => {
  it('reads reposts off post.quotedPostOwnerAndTime instead of a repost doctype', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const { notificationService } = await import('./notification-service')
    vi.spyOn(notificationService, 'getBlogPostNotifications').mockResolvedValue([])
    vi.spyOn(notificationService, 'getBlogCommentNotifications').mockResolvedValue([])
    for (const reader of ['getLikeNotifications', 'getRepostNotifications', 'getReplyNotifications'] as const) {
      vi.spyOn(notificationService, reader).mockResolvedValue([])
    }

    await notificationService.pollNewNotifications('viewer', 1000)

    const queries: QueryDocumentsOptions[] = bundle.mock.calls[0][0]
    expect(queries.map(query => query.documentTypeName))
      .toEqual(['follow', 'postMention', 'followRequest', 'like', 'likeReply', 'post', 'reply'])
    expect(queries[5]).toMatchObject({
      where: [['quotedPostOwnerId', '==', 'viewer'], ['$createdAt', '>', 1000]],
      orderBy: [['quotedPostOwnerId', 'asc'], ['$createdAt', 'desc']],
    })
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
