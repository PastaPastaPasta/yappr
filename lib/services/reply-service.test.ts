import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

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

describe('reply notifications on v9', () => {
  const idOf = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
  const [ME, ROOT_MINE, ROOT_THEIRS, MY_REPLY] = [1, 2, 3, 4].map(idOf)

  it('keeps nested replies and direct replies under my own root, and drops a direct reply that only claims me', async () => {
    // The topology descriptor is cached per module: a fresh registry reads v9.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
    const { replyService: v9Replies } = await import('./reply-service')
    const { postService } = await import('./post-service')
    const getMany = vi.spyOn(postService, 'getMany').mockResolvedValue([{ id: ROOT_MINE, author: { id: ME } }] as never)
    const reply = (id: string, rootPostId: string, replyToReplyId?: string) => ({
      $id: id, $ownerId: 'Stranger', $createdAt: 1, content: id, rootPostId, parentOwnerId: ME, ...(replyToReplyId ? { replyToReplyId } : {}),
    })
    const replies = await v9Replies.getRepliesToMyContent(ME, undefined, [
      reply('direct-mine', ROOT_MINE),
      reply('direct-spoofed', ROOT_THEIRS),
      reply('nested', ROOT_THEIRS, MY_REPLY),
    ])
    expect(replies.map((r) => r.id).sort()).toEqual(['direct-mine', 'nested'])
    expect(getMany).toHaveBeenCalledWith([ROOT_MINE, ROOT_THEIRS])
    vi.unstubAllEnvs()
  })
})
