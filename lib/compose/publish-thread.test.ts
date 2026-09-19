import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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


describe('publishThread retry linkage', () => {
  const input = (lastPostedId: string | null): PublishInput => ({
    authorId: 'author',
    posts: [{ threadPostId: 'draft-remaining', content: 'remaining part' }],
    replyingTo: null,
    quotingPost: null,
    lastPostedId,
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
    }, { encryption: undefined, mediaUrl: undefined })
    expect(result.successful).toEqual([{ index: 0, postId: 'new-reply', content: 'remaining part', threadPostId: 'draft-remaining' }])
  })

  it('waits for an unconfirmed previous part before submitting a resumed reply', async () => {
    services.isUnconfirmed.mockImplementation((id) => id === 'previous-reply')
    const result = await publishThread(input('previous-reply'))
    expect(services.settleUnconfirmed).toHaveBeenCalledWith('previous-reply')
    expect(services.createPost).not.toHaveBeenCalled()
    expect(services.createReply).not.toHaveBeenCalled()
    expect(result.failedAtIndex).toBe(0)
  })

  it('still creates a root when there is no confirmed prefix', async () => {
    const result = await publishThread(input(null))
    expect(services.createPost).toHaveBeenCalledOnce()
    expect(services.createReply).not.toHaveBeenCalled()
    expect(result.successful[0].postId).toBe('new-root')
  })
})
