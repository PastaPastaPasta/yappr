import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const { query, count } = vi.hoisted(() => ({ query: vi.fn(), count: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query, count } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))
import { replyService } from './reply-service'
import { replyToPost } from './post-service'
import { shouldGateSensitive } from '@/lib/sensitive-content'

beforeEach(() => {
  query.mockReset()
  count.mockReset()
})

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

describe('v10 repliesOf reads', () => {
  const idOf = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
  const hexOf = (id: string) => Array.from(bs58.decode(id), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const [ROOT_A, ROOT_B, R1, R2, R3, LOOSE] = [1, 2, 3, 4, 5, 6].map(idOf)

  async function v10Replies() {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    return (await import('./reply-service')).replyService
  }

  it('pins every per-reply child count to the reply\'s root, one grouped query per root', async () => {
    const replies = await v10Replies()
    count.mockImplementation(async ({ where }: { where: unknown[][] }) => where[0][2] === ROOT_A
      ? new Map([[hexOf(R1), 2n]])
      : new Map([[hexOf(R3), 5n]]))
    // A reply with no known root is read to learn it; unreadable, it counts 0.
    const get = vi.spyOn(replies, 'get').mockResolvedValue(null)

    const counts = await replies.countRepliesForPosts([R1, R2, R3, LOOSE], 'reply', new Map([[R1, ROOT_A], [R2, ROOT_A], [R3, ROOT_B]]))

    expect(Object.fromEntries(counts)).toEqual({ [R1]: 2, [R2]: 0, [R3]: 5, [LOOSE]: 0 })
    expect(count.mock.calls.map(([q]) => [q.where, q.groupBy])).toEqual([
      [[['rootPostId', '==', ROOT_A], ['replyToReplyId', 'in', [R1, R2]]], ['replyToReplyId']],
      [[['rootPostId', '==', ROOT_B], ['replyToReplyId', 'in', [R3]]], ['replyToReplyId']],
    ])
    expect(get).toHaveBeenCalledWith(LOOSE)
    vi.unstubAllEnvs()
  })

  it('counts a post\'s whole thread by root alone and a reply\'s children under its root', async () => {
    const replies = await v10Replies()
    count.mockResolvedValue(new Map([['', 3n]]))
    expect(await replies.countReplies(ROOT_A, 'post')).toBe(3)
    expect(await replies.countReplies(R1, 'reply', ROOT_A)).toBe(3)
    expect(count.mock.calls.map(([q]) => q.where)).toEqual([
      [['rootPostId', '==', ROOT_A]],
      [['rootPostId', '==', ROOT_A], ['replyToReplyId', '==', R1]],
    ])
    vi.unstubAllEnvs()
  })

  it('lists the whole thread grouped by parent, and a reply\'s children pinned to the root', async () => {
    const replies = await v10Replies()
    query.mockResolvedValue([])
    await replies.getReplies(ROOT_A, { skipEnrichment: true })
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['rootPostId', '==', ROOT_A]],
      orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']],
      limit: 50,
    })

    await replies.getNestedReplies([R1], { rootPostId: ROOT_A, skipEnrichment: true })
    expect(query.mock.calls[1][0]).toMatchObject({
      where: [['rootPostId', '==', ROOT_A], ['replyToReplyId', '==', R1]],
      orderBy: [['$createdAt', 'asc']],
    })
    // Without the root there is no servable shape: nothing is queried.
    expect(await replies.getNestedReplies([R1], { skipEnrichment: true })).toEqual(new Map([[R1, []]]))
    expect(query).toHaveBeenCalledTimes(2)
    vi.unstubAllEnvs()
  })

  it('keeps v9\'s unpinned per-reply counts and rootAndTime listing', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
    const { replyService: v9Replies } = await import('./reply-service')
    count.mockResolvedValue(new Map())
    query.mockResolvedValue([])
    await v9Replies.countRepliesForPosts([R1], 'reply', new Map([[R1, ROOT_A]]))
    expect(count.mock.calls[0][0].where).toEqual([['replyToReplyId', 'in', [R1]]])
    await v9Replies.getReplies(ROOT_A, { skipEnrichment: true })
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['rootPostId', '==', ROOT_A], ['$createdAt', '>', 0]],
      orderBy: [['rootPostId', 'asc'], ['$createdAt', 'asc']],
    })
    vi.unstubAllEnvs()
  })
})

describe('v14 replies: no stored owner, two derived notification windows', () => {
  const idOf = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
  const [ME, MY_ROOT, MY_REPLY, THEIR_REPLY, STRANGER] = [1, 2, 3, 4, 5].map(idOf)

  async function v14Replies() {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v14')
    return (await import('./reply-service')).replyService
  }

  const reply = (id: string, replyToReplyId?: string) => ({
    $id: id, $ownerId: STRANGER, $createdAt: Date.now(), content: id, rootPostId: MY_ROOT, ...(replyToReplyId ? { replyToReplyId } : {}),
  })

  it('writes neither parentOwnerId nor rootOwnerId', async () => {
    const replies = await v14Replies()
    const create = vi.spyOn(replies, 'create').mockResolvedValue({} as never)
    await replies.createReply(STRANGER, 'hi', { rootPostId: MY_ROOT, replyToReplyId: MY_REPLY, parentOwnerId: ME, rootOwnerId: ME })
    const data = create.mock.calls[0][1]
    expect(Object.keys(data).sort()).toEqual(['content', 'replyToReplyId', 'rootPostId'])
    vi.unstubAllEnvs()
  })

  it('answers the nested replies to my replies and the top-level replies of my threads, each once', async () => {
    const replies = await v14Replies()
    // parentOwnerRecent: only nested replies whose parent is mine. rootOwnerRecent: every reply of my thread.
    const nested = [reply('to-my-reply', MY_REPLY)]
    const thread = [reply('top-level'), reply('to-my-reply', MY_REPLY), reply('between-others', THEIR_REPLY)]
    query.mockImplementation(async ({ where, timeRange }: { where: unknown[][]; timeRange: Array<{ selector: string }> }) => {
      // Each window is read twice (the current and the previous one); serve the current one only.
      if (timeRange[0].selector !== 'newest') return []
      expect(where).toHaveLength(1)
      expect(where[0].slice(1)).toEqual(['==', ME])
      return where[0][0] === 'replyToReplyId.$ownerId' ? nested : thread
    })

    const found = await replies.getRepliesToMyContent(ME, new Date(0))

    expect(found.map((r) => [r.id, r.replyToReplyId ?? null])).toEqual([['to-my-reply', MY_REPLY], ['top-level', null]])
    expect(query.mock.calls.map(([q]) => q.where[0][0]).sort()).toEqual(['replyToReplyId.$ownerId', 'replyToReplyId.$ownerId', 'rootPostId.$ownerId', 'rootPostId.$ownerId'])
    vi.unstubAllEnvs()
  })

  it('rejects when either window cannot be read', async () => {
    const replies = await v14Replies()
    query.mockImplementation(async ({ where }: { where: unknown[][] }) => {
      if (where[0][0] === 'rootPostId.$ownerId') throw new Error('offline')
      return []
    })
    await expect(replies.getRepliesToMyContent(ME, new Date(0))).rejects.toThrow('offline')
    vi.unstubAllEnvs()
  })
})
