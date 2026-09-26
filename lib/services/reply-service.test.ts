import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))
import { replyService } from './reply-service'
import { replyToPost } from './post-service'
import { shouldGateSensitive } from '@/lib/sensitive-content'

beforeEach(() => query.mockReset())

describe('profile reply pagination', () => {
  it('reaches the oldest reply after a full page without repeating the cursor', async () => {
    const records = Array.from({ length: 51 }, (_, index) => ({
      $id: `reply-${index}`, $ownerId: '111111111', $createdAt: 2000 - index,
      content: `Reply ${index}`, parentId: '222222222', parentOwnerId: '111111111',
    }))
    query.mockResolvedValueOnce(records.slice(0, 50)).mockResolvedValueOnce(records.slice(50))

    const first = await replyService.getUserReplies('111111111', { limit: 50, skipEnrichment: true })
    expect(first.documents).toHaveLength(50)
    expect(first.nextCursor).toBe('reply-49')
    const second = await replyService.getUserReplies('111111111', {
      limit: 50, startAfter: first.nextCursor, skipEnrichment: true,
    })
    expect(second.documents.map(reply => reply.id)).toEqual(['reply-50'])
    expect(second.nextCursor).toBeUndefined()
    expect(query.mock.calls[1][0].startAfter).toBe('reply-49')
    expect(query.mock.calls[1][0].orderBy).toEqual([['$ownerId', 'asc'], ['$createdAt', 'desc']])
  })

  it('does not turn a failed next page into successful end-of-history', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(replyService.getUserReplies('111111111', {
      limit: 50, startAfter: 'reply-49', skipEnrichment: true,
    })).rejects.toThrow('offline')
  })
})

describe('reply sensitive flag', () => {
  it('keeps a flagged thread continuation gated through replyToPost', async () => {
    query.mockResolvedValueOnce([
      { $id: 'flagged', $ownerId: '111111111', $createdAt: 2000, content: 'part 2', parentId: '222222222', parentOwnerId: '111111111', sensitive: true },
      { $id: 'plain', $ownerId: '111111111', $createdAt: 1999, content: 'reply', parentId: '222222222', parentOwnerId: '111111111' },
    ])
    const { documents } = await replyService.getUserReplies('111111111', { limit: 50, skipEnrichment: true })
    const [flagged, plain] = documents.map(replyToPost)
    expect(flagged.sensitive).toBe(true)
    expect(shouldGateSensitive(flagged, 'blur')).toBe(true)
    expect(plain.sensitive).toBeUndefined()
    expect(shouldGateSensitive(plain, 'blur')).toBe(false)
  })
})
