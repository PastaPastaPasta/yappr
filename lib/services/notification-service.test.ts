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
