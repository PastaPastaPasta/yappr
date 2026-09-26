import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'
import { planPosts, publishThread, type PublishInput } from './publish-thread'

const services = vi.hoisted(() => ({ createPost: vi.fn(), createReply: vi.fn(), isUnconfirmed: vi.fn(), settleUnconfirmed: vi.fn() }))
vi.mock('@/lib/services', () => ({ postService: { createPost: services.createPost } }))
vi.mock('@/lib/services/reply-service', () => ({ replyService: { createReply: services.createReply } }))
vi.mock('@/lib/unconfirmed-writes', () => ({ isUnconfirmed: services.isUnconfirmed, settleUnconfirmed: services.settleUnconfirmed, markUnconfirmed: vi.fn() }))

const thread = [
  { id: 'a', content: '  first  ', visibility: 'public' as const },
  { id: 'b', content: 'second', postedPostId: 'landed' },
  { id: 'c', content: '   ' },
  { id: 'd', content: 'fourth', teaser: ' tease ' },
]

describe('planPosts', () => {
  it('keeps unposted posts with content, trimmed, in order', () => {
    expect(planPosts(thread, undefined, false).map((p) => [p.threadPostId, p.content, p.teaser])).toEqual([
      ['a', 'first', undefined],
      ['d', 'fourth', 'tease'],
    ])
  })

  it('appends the image URL to the first post only when the content is encrypted', () => {
    expect(planPosts(thread, 'ipfs://cid', true)[0].content).toBe('first\n\nipfs://cid')
    expect(planPosts(thread, 'ipfs://cid', true)[1].content).toBe('fourth')
    expect(planPosts(thread, 'ipfs://cid', false)[0].content).toBe('first')
  })
})

describe('planPosts predecessor', () => {
  const posts = (...ids: (string | undefined)[]) => ids.map((postedPostId, i) => ({ id: `p${i}`, content: `part ${i}`, postedPostId }))
  const predecessors = (thread: { id: string; content: string; postedPostId?: string }[]) =>
    planPosts(thread, undefined, false).map((p) => [p.threadPostId, p.predecessorPostedId])

  it('is unset when nothing has been posted', () => {
    expect(predecessors(posts(undefined, undefined))).toEqual([['p0', undefined], ['p1', undefined]])
  })

  it('is the last part of a confirmed prefix', () => {
    expect(predecessors(posts('a', 'b', undefined))).toEqual([['p2', 'b']])
  })

  it('chains each gap to its own posted predecessor, not a later posted part', () => {
    expect(predecessors(posts('a', undefined, 'c', undefined))).toEqual([['p1', 'a'], ['p3', 'c']])
  })

  it('skips blank unposted parts when finding a predecessor', () => {
    const thread = [{ id: 'x', content: 'x', postedPostId: 'a' }, { id: 'y', content: '  ' }, { id: 'z', content: 'z', postedPostId: 'c' }, { id: 'w', content: 'w' }]
    expect(predecessors(thread)).toEqual([['w', 'c']])
  })
})

describe('publishThread retry linkage', () => {
  const input = (lastPostedId: string | null): PublishInput => ({
    authorId: 'author',
    posts: [{ threadPostId: 'draft-remaining', content: 'remaining part', predecessorPostedId: lastPostedId ?? undefined }],
    replyingTo: null,
    quotingPost: null,
    knownThreadRootId: lastPostedId ? 'original-root' : null,
    isPrivate: false,
    inheritedEncryption: null,
    pollEmbed: undefined,
    mediaUrlField: undefined,
    markSensitive: false,
    onProgress: vi.fn(),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    services.createPost.mockResolvedValue({ id: 'new-root' })
    services.createReply.mockResolvedValue({ id: 'new-reply' })
    services.isUnconfirmed.mockReturnValue(false)
    services.settleUnconfirmed.mockResolvedValue(false)
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['original-root', 'previous-reply'])('continues after %s without recreating the confirmed prefix', async (lastPostedId) => {
    const result = await publishThread(input(lastPostedId))
    expect(services.createPost).not.toHaveBeenCalled()
    expect(services.createReply).toHaveBeenCalledExactlyOnceWith('author', 'remaining part', {
      rootPostId: 'original-root',
      replyToReplyId: lastPostedId === 'original-root' ? undefined : lastPostedId,
      parentOwnerId: 'author',
    }, { encryption: undefined, sensitive: undefined, mediaUrl: undefined })
    expect(result.successful).toEqual([{ index: 0, postId: 'new-reply', content: 'remaining part', threadPostId: 'draft-remaining' }])
  })

  it('keeps the thread sensitive flag on a retried own-thread part', async () => {
    await publishThread({ ...input('previous-reply'), markSensitive: true })
    expect(services.createReply).toHaveBeenCalledOnce()
    expect(services.createReply.mock.calls[0][3]).toMatchObject({ sensitive: true })
  })

  it('waits for an unconfirmed previous part before submitting a resumed reply', async () => {
    services.isUnconfirmed.mockImplementation((id) => id === 'previous-reply')
    const result = await publishThread(input('previous-reply'))
    expect(services.settleUnconfirmed).toHaveBeenCalledWith('previous-reply')
    expect(services.createPost).not.toHaveBeenCalled()
    expect(services.createReply).not.toHaveBeenCalled()
    expect(result.failedAtIndex).toBe(0)
  })

  it('chains each retried gap to its own predecessor when posted and pending parts alternate', async () => {
    // First attempt: A confirmed, B timed out, C confirmed under A, D failed.
    const thread = [
      { id: 'A', content: 'a', postedPostId: 'root-a' },
      { id: 'B', content: 'b' },
      { id: 'C', content: 'c', postedPostId: 'reply-c' },
      { id: 'D', content: 'd' },
    ]
    services.createReply.mockResolvedValueOnce({ id: 'reply-b' }).mockResolvedValueOnce({ id: 'reply-d' })
    const result = await publishThread({ ...input(null), posts: planPosts(thread, undefined, false), knownThreadRootId: 'root-a' })
    expect(services.createPost).not.toHaveBeenCalled()
    expect(services.createReply.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['b', { rootPostId: 'root-a', replyToReplyId: undefined, parentOwnerId: 'author' }],
      ['d', { rootPostId: 'root-a', replyToReplyId: 'reply-c', parentOwnerId: 'author' }],
    ])
    expect(result.successful.map((p) => p.threadPostId)).toEqual(['B', 'D'])
  })

  it('chains a part after a timed-out one to the timed-out part\'s target', async () => {
    const thread = [{ id: 'A', content: 'a', postedPostId: 'root-a' }, { id: 'B', content: 'b' }, { id: 'C', content: 'c' }]
    services.createReply.mockImplementation(async (_author, content: string) => {
      if (content === 'b') throw new Error('timeout')
      return { id: 'reply-c' }
    })
    vi.useFakeTimers()
    try {
      const pending = publishThread({ ...input(null), posts: planPosts(thread, undefined, false), knownThreadRootId: 'root-a' })
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.timedOut).toEqual([{ index: 0, threadPostId: 'B' }])
      expect(services.createReply.mock.calls.at(-1)?.slice(1, 3)).toEqual(['c', { rootPostId: 'root-a', replyToReplyId: undefined, parentOwnerId: 'author' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still creates a root when there is no confirmed prefix', async () => {
    const result = await publishThread(input(null))
    expect(services.createPost).toHaveBeenCalledOnce()
    expect(services.createReply).not.toHaveBeenCalled()
    expect(result.successful[0].postId).toBe('new-root')
  })
})

describe('publishThread sensitive flag', () => {
  const otherUsersPost: Post = {
    id: 'their-post', targetKind: 'post', content: 'theirs', createdAt: new Date(1000),
    author: { id: 'someone-else', username: '', displayName: '', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(1000) },
    likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0,
  }
  const base: PublishInput = {
    authorId: 'author',
    posts: [{ threadPostId: 'draft-1', content: 'root part' }, { threadPostId: 'draft-2', content: 'second part' }],
    replyingTo: null,
    quotingPost: null,
    knownThreadRootId: null,
    isPrivate: false,
    inheritedEncryption: null,
    pollEmbed: undefined,
    mediaUrlField: undefined,
    markSensitive: true,
    onProgress: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    services.createPost.mockResolvedValue({ id: 'new-root' })
    services.createReply.mockResolvedValue({ id: 'new-reply' })
    services.isUnconfirmed.mockReturnValue(false)
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('marks the root and every continuation part of an own thread', async () => {
    await publishThread(base)
    expect(services.createPost).toHaveBeenCalledOnce()
    expect(services.createPost.mock.calls[0][2]).toMatchObject({ sensitive: true })
    expect(services.createReply).toHaveBeenCalledOnce()
    expect(services.createReply.mock.calls[0][2]).toMatchObject({ rootPostId: 'new-root', parentOwnerId: 'author' })
    expect(services.createReply.mock.calls[0][3]).toMatchObject({ sensitive: true })
  })

  it('does not mark a reply to someone else even when the profile seeded the flag on', async () => {
    await publishThread({ ...base, posts: [{ threadPostId: 'draft-1', content: 'my reply' }], replyingTo: otherUsersPost })
    expect(services.createPost).not.toHaveBeenCalled()
    expect(services.createReply).toHaveBeenCalledOnce()
    expect(services.createReply.mock.calls[0][2]).toMatchObject({ rootPostId: 'their-post', parentOwnerId: 'someone-else' })
    expect(services.createReply.mock.calls[0][3].sensitive).toBeUndefined()
  })
})
