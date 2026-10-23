/**
 * Blogs (`api/blog.ts`) with lib's blog services mocked: the reads' DTOs and
 * the writes' input checks, the lib calls each ticket makes, and the probes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  viewer: 'AUTHOR' as string | null,
  blogService: {
    isConfigured: vi.fn(() => true), getBlog: vi.fn(), getOrThrow: vi.fn(), getMany: vi.fn(), getBlogsByOwner: vi.fn(), getBlogTimelinePage: vi.fn(),
    getNewestBlogs: vi.fn(), createBlog: vi.fn(), updateBlog: vi.fn(), deleteBlog: vi.fn(), clearCache: vi.fn(),
  },
  blogPostService: {
    getOrThrow: vi.fn(), getPostBySlug: vi.fn(), getPostsByBlog: vi.fn(), getLatestPublishedPosts: vi.fn(), getOwnerPostsPage: vi.fn(),
    createPost: vi.fn(), updatePost: vi.fn(), deletePost: vi.fn(), clearCache: vi.fn(),
  },
  blogCommentService: { getCommentsByPost: vi.fn(), createComment: vi.fn(), deleteComment: vi.fn() },
  blogFollowService: { isFollowingBlog: vi.fn(), countBlogFollowers: vi.fn(async () => 2), followBlog: vi.fn(), unfollowBlog: vi.fn(), getFollowedBlogIds: vi.fn() },
  contractReportService: { own: vi.fn(), file: vi.fn(), withdraw: vi.fn() },
  charterReasonText: vi.fn(async (_contract: string, label: number | undefined) => (label === 3 ? 'Spam or scam' : null)),
}))

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/constants', async (load) => ({ ...await load<object>(), blogIsV7: () => true, blogIsV9: () => true, blogLabelsAreTyped: () => true }))
vi.mock('@/lib/services/blog-service', () => ({ blogService: m.blogService }))
vi.mock('@/lib/services/blog-post-service', async (load) => ({ ...await load<object>(), blogPostService: m.blogPostService }))
vi.mock('@/lib/services/blog-comment-service', async (load) => ({ ...await load<object>(), blogCommentService: m.blogCommentService }))
vi.mock('@/lib/services/blog-follow-service', () => ({ blogFollowService: m.blogFollowService }))
vi.mock('@/lib/services/contract-report-service', async (load) => ({ ...await load<object>(), contractReportService: m.contractReportService }))
vi.mock('../../src/dto/hydrate', async (load) => ({ ...await load<object>(), loadUserSummaries: vi.fn(async () => new Map()) }))
vi.mock('@/lib/services/charter-reasons', async (load) => ({ ...await load<object>(), charterReasonText: m.charterReasonText }))

import { moderationFieldOf } from '@/lib/services/moderation-carry'
import { blogReads, createBlogWrites } from '../../src/api/blog'
import type { WriteHandler, TicketStore } from '../../src/writes/tickets'
import type { WriteTicket } from '../../src/writes/types'

const BLOG = 'B1YTHPCmXo6Yywxz2msLwxRZ5eWuUSMwfwiq258mzWyq'
const POST = '7mVtG4R4ZMTZ3veA95Y7fai8zDvX4HB6tPUGExyMZaVj'
const AUTHOR = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'

/** A ticket store that records handlers and submissions. */
function fakeStore() {
  const handlers = new Map<string, WriteHandler<unknown>>()
  const submitted: { op: string; args: unknown; target: unknown }[] = []
  const store = {
    register: (op: string, handler: WriteHandler<unknown>) => { handlers.set(op, handler) },
    submit: (request: { op: string; args: unknown; target: unknown }) => {
      submitted.push(request)
      return { id: 't1', op: request.op, state: 'pending' } as unknown as WriteTicket
    },
  } as unknown as TicketStore
  const ctx = (ticket: Partial<WriteTicket> = {}) => ({
    ticket: { identityId: AUTHOR, documents: [], target: null, ...ticket } as unknown as WriteTicket,
    stage: vi.fn(), progress: vi.fn(), documents: vi.fn(), probe: vi.fn(async () => ({ state: 'applied' as const })),
  })
  return { store, handlers, submitted, ctx }
}

const libPost = (overrides: Record<string, unknown> = {}) => ({
  id: POST, ownerId: AUTHOR, blogId: BLOG, title: 'Title', subtitle: '​Hidden summary', slug: 'title', publishedAt: 1_790_000_000_000,
  createdAt: new Date(1_790_000_000_000), content: [{ type: 'paragraph', content: 'Hello there' }], labels: ['a'], $revision: 2, ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.viewer = AUTHOR
})

describe('blog reads', () => {
  it('maps a post, keeping its blocks untouched and decoding a hidden summary', async () => {
    m.blogPostService.getPostBySlug.mockResolvedValue(libPost())
    const post = await blogReads.postBySlug(BLOG, 'title')
    expect(post).toMatchObject({ id: POST, summary: null, summaryText: 'Hidden summary', summaryHidden: true, edited: true, excerpt: 'Hidden summary' })
    expect(post?.content).toEqual([{ type: 'paragraph', content: 'Hello there' }])
  })

  it("hides someone else's draft", async () => {
    m.viewer = 'READER'
    m.blogPostService.getOrThrow.mockResolvedValue(libPost({ publishedAt: undefined }))
    expect(await blogReads.post(POST)).toBeNull()
  })

  it('rejects a failed blog or post read instead of reading it as gone', async () => {
    m.blogService.getBlog.mockRejectedValue(new Error('timeout'))
    m.blogPostService.getOrThrow.mockRejectedValue(new Error('timeout'))
    await expect(blogReads.get(BLOG)).rejects.toBeTruthy()
    expect(m.blogService.getBlog).toHaveBeenCalledWith(BLOG, { throwOnError: true })
    await expect(blogReads.post(POST)).rejects.toBeTruthy()
  })

  it("can't trace a publish whose title gives no address of its own", async () => {
    expect(await blogReads.publishOutcome(BLOG, '日本語', Date.now())).toBe('unknown')
    expect(m.blogPostService.getPostBySlug).not.toHaveBeenCalled()
    m.blogPostService.getPostBySlug.mockResolvedValue(null)
    expect(await blogReads.publishOutcome(BLOG, 'Hello there', Date.now())).toBe('absent')
    expect(m.blogPostService.getPostBySlug).toHaveBeenCalledWith(BLOG, 'hello-there')
  })

  it("says whether a title's own address is free before a publish", async () => {
    m.blogPostService.getPostBySlug.mockResolvedValue(null)
    expect(await blogReads.publishAddressFree(BLOG, 'Hello there')).toBe(true)
    m.blogPostService.getPostBySlug.mockResolvedValue(libPost())
    expect(await blogReads.publishAddressFree(BLOG, 'Hello there')).toBe(false)
    m.blogPostService.getPostBySlug.mockClear()
    expect(await blogReads.publishAddressFree(BLOG, '🎉')).toBe(false)
    expect(m.blogPostService.getPostBySlug).not.toHaveBeenCalled()
    m.blogPostService.getPostBySlug.mockRejectedValueOnce(new Error('timeout'))
    await expect(blogReads.publishAddressFree(BLOG, 'Hello there')).rejects.toBeTruthy()
  })

  it('lists published posts to readers and drafts to the owner', async () => {
    m.blogPostService.getPostsByBlog.mockResolvedValue([libPost(), libPost({ id: 'D'.repeat(44), publishedAt: undefined })])
    expect((await blogReads.posts(BLOG)).items).toHaveLength(2)
    m.viewer = 'READER'
    expect((await blogReads.posts(BLOG)).items).toHaveLength(1)
  })
})

describe('blog writes', () => {
  it('refuses bad input before a ticket is issued', async () => {
    const { store } = fakeStore()
    const writes = createBlogWrites(store)
    await expect(writes.create({ name: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(writes.create({ name: 'Ok', avatar: 'http://insecure.example/a.png' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(writes.publish(BLOG, { title: 'x'.repeat(200), content: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(writes.comment(POST, AUTHOR, '   ')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('skips the address pre-read for a title with no address of its own', async () => {
    const { store, handlers, submitted, ctx } = fakeStore()
    await createBlogWrites(store).publish(BLOG, { title: '日本語', content: [{ type: 'paragraph' }] })
    m.blogPostService.createPost.mockResolvedValue({ id: POST, __createConfirmed: true })
    await handlers.get('blogPost.publish')?.run(submitted[0].args, ctx())
    expect(m.blogPostService.getPostBySlug).not.toHaveBeenCalled()
    expect(m.blogPostService.createPost).toHaveBeenCalled()
  })

  it('publishes through createPost, recording the created post', async () => {
    const { store, handlers, submitted, ctx } = fakeStore()
    const writes = createBlogWrites(store)
    await writes.publish(BLOG, { title: ' Hello ', summary: 'Sum', summaryHidden: true, content: [{ type: 'paragraph' }], commentsEnabled: false })
    expect(submitted[0]).toMatchObject({ op: 'blogPost.publish', target: { blog: { type: 'blog', id: BLOG } } })
    m.blogPostService.createPost.mockResolvedValue({ id: POST, __createConfirmed: true })
    const result = await handlers.get('blogPost.publish')?.run(submitted[0].args, ctx())
    expect(m.blogPostService.createPost).toHaveBeenCalledWith(AUTHOR, expect.objectContaining({
      blogId: BLOG, title: 'Hello', subtitle: '​Sum', commentsEnabled: false, content: [{ type: 'paragraph' }],
    }))
    expect(result).toMatchObject({ state: 'confirmed', documents: [{ type: 'blogPost', id: POST, action: 'create' }] })
  })

  it('keeps the stored custom CSS when the look changes', async () => {
    const { store, handlers, submitted, ctx } = fakeStore()
    const writes = createBlogWrites(store)
    m.blogService.getOrThrow.mockResolvedValue({ id: BLOG, name: 'Blog', themeConfig: { customCSS: 'color: red;', colors: {}, fonts: {} } })
    const theme = {
      colors: { bg: '#ffffff', text: '#111111', accent: '#222222', heading: '#000000', link: '#0000ff', surface: '#eeeeee', border: '#dddddd' },
      fonts: { body: 'lora', heading: 'inter' }, layout: 'wide' as const, headerStyle: 'hero' as const,
    }
    await writes.update(BLOG, { theme })
    await handlers.get('blog.update')?.run(submitted[0].args, ctx())
    const data = m.blogService.updateBlog.mock.calls[0][2]
    expect(data.themeConfig).toMatchObject({ customCSS: 'color: red', colors: theme.colors, fonts: theme.fonts })
  })

  it('proves a post delete by its tombstone', async () => {
    const { store, handlers } = fakeStore()
    createBlogWrites(store)
    m.blogPostService.getOrThrow.mockResolvedValue(libPost({ deleted: true }))
    const handler = handlers.get('blogPost.delete')
    const ticket = { identityId: AUTHOR, target: { blog: { type: 'blogPost', id: POST } } } as unknown as WriteTicket
    const proof = await handler?.probe?.(ticket, { postId: POST }, { recheckDelay: async () => undefined } as never)
    expect(proof).toEqual({ state: 'applied' })
  })

  it('proves an unfollow lib skipped with a strict read, never taking "nothing to do" on trust', async () => {
    const { store, handlers, ctx } = fakeStore()
    createBlogWrites(store)
    m.blogFollowService.unfollowBlog.mockResolvedValue({ success: true })
    const run = handlers.get('blog.unfollow')?.run
    const probing = ctx()
    probing.probe.mockResolvedValueOnce({ state: 'unknown', error: new Error('read failed') } as never)
    await expect(run?.({ blogId: BLOG }, probing)).resolves.toEqual({ state: 'unconfirmed' })
    m.blogFollowService.unfollowBlog.mockResolvedValue({ success: true, transactionHash: 'X' })
    await expect(run?.({ blogId: BLOG }, ctx())).resolves.toMatchObject({ state: 'confirmed' })
  })

  it('reads a comment refused before sending as not sent', async () => {
    const { store, handlers, ctx } = fakeStore()
    createBlogWrites(store)
    m.blogCommentService.createComment.mockRejectedValue(new Error('Could not load this post to check that it takes comments. Try again.'))
    await expect(handlers.get('blogComment.create')?.run({ postId: POST, postOwnerId: AUTHOR, content: 'hi' }, ctx()))
      .rejects.toMatchObject({ name: 'NotSentError' })
  })

  it('reports another author only', async () => {
    const { store, submitted } = fakeStore()
    const writes = createBlogWrites(store)
    await expect(writes.report({ docType: 'blogPost', targetId: POST, ownerId: AUTHOR }, 0)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.viewer = 'R'.repeat(44)
    await writes.report({ docType: 'blogComment', targetId: POST, ownerId: AUTHOR }, 0, 'spam')
    expect(submitted[0]).toMatchObject({ op: 'blog.report', target: { blog: { type: 'blogComment', id: POST } } })
  })
})

/**
 * Blog v10 ("hide, don't delete"): what a moderator's hide (`mod`, `modLabel`,
 * `$moderatedBy`, `$moderatedAt`) and a restricted author's `live: 2` look
 * like once lib has read them (its `moderationFieldOf`, as every blog service
 * transform carries them).
 */
describe('blog v10 moderation', () => {
  const MODERATOR = '9yQpMwZMJkRbBQwhZbthsWKPEXKowCnywxGoKek16qjg'
  const HIDDEN_AT = 1_790_000_100_000
  const hide = (mod = 1) => moderationFieldOf({ mod, modLabel: 3, $moderatedBy: MODERATOR, $moderatedAt: HIDDEN_AT })
  const v10Post = (overrides: Record<string, unknown> = {}) => libPost({ live: 1, ...overrides })
  const libBlog = (overrides: Record<string, unknown> = {}) => ({
    id: BLOG, ownerId: AUTHOR, name: 'My blog', description: 'About things', avatar: 'ipfs://avatar', labels: ['x'], createdAt: new Date(1_780_000_000_000), ...overrides,
  })
  const withheldPost = { title: '', summary: null, summaryText: '', excerpt: '', coverImage: null, labels: [], content: [], commentsEnabled: false, moderation: { hidden: true, restricted: false, withheld: true } }
  const label = { hidden: true, label: 3, reason: 'Spam or scam', by: MODERATOR, at: new Date(HIDDEN_AT) }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('on the official apps (the listed lane only)', () => {
    it('withholds a hidden post read by id, its author included', async () => {
      m.blogPostService.getOrThrow.mockResolvedValue(v10Post(hide()))
      expect(await blogReads.post(POST)).toMatchObject({ id: POST, blogId: BLOG, slug: 'title', ...withheldPost })
      m.viewer = 'READER'
      expect(await blogReads.post(POST)).toMatchObject(withheldPost)
      expect(m.charterReasonText).not.toHaveBeenCalled()
    })

    it('withholds a hidden post read by its address, and one on legal hold', async () => {
      m.blogPostService.getPostBySlug.mockResolvedValue(v10Post(hide()))
      expect(await blogReads.postBySlug(BLOG, 'title')).toMatchObject(withheldPost)
      m.blogPostService.getPostBySlug.mockResolvedValue(v10Post(hide(2)))
      expect(await blogReads.postBySlug(BLOG, 'title')).toMatchObject(withheldPost)
    })

    it('shows a restricted author\'s post reached by id in full, without a label', async () => {
      m.blogPostService.getOrThrow.mockResolvedValue(v10Post({ live: 2 }))
      const post = await blogReads.post(POST)
      expect(post).toMatchObject({ title: 'Title', content: [{ type: 'paragraph', content: 'Hello there' }] })
      expect(post?.moderation).toBeUndefined()
    })

    it('withholds a hidden blog read by id', async () => {
      m.blogService.getBlog.mockResolvedValue(libBlog(hide()))
      expect(await blogReads.get(BLOG)).toMatchObject({
        id: BLOG, ownerId: AUTHOR, owner: null, name: '', description: null, avatar: null, labels: [], moderation: { hidden: true, restricted: false, withheld: true },
      })
    })

    it('withholds a hidden comment\'s author and text', async () => {
      m.blogCommentService.getCommentsByPost.mockResolvedValue([
        { id: 'C1', ownerId: AUTHOR, blogPostId: POST, createdAt: new Date(1), content: 'shown' },
        { id: 'C2', ownerId: AUTHOR, blogPostId: POST, createdAt: new Date(2), content: 'spam', ...hide() },
      ])
      const comments = await blogReads.comments(POST)
      expect(comments[0]).toMatchObject({ content: 'shown' })
      expect(comments[0].moderation).toBeUndefined()
      expect(comments[1]).toMatchObject({ author: null, content: '', moderation: { hidden: true, withheld: true } })
    })

    it('lists the author\'s own blogs with a hidden one, labelled', async () => {
      m.blogService.getBlogsByOwner.mockResolvedValue([libBlog(), libBlog({ id: 'H'.repeat(44), name: 'Hidden blog', ...hide() })])
      const blogs = await blogReads.mine()
      expect(m.blogService.getBlogsByOwner).toHaveBeenCalledWith(AUTHOR, { includeHidden: true })
      expect(blogs.map(blog => blog.name)).toEqual(['My blog', 'Hidden blog'])
      expect(blogs[0].moderation).toBeUndefined()
      expect(blogs[1].moderation).toEqual({ restricted: false, ...label })
    })

    it('lists the author\'s own posts across both lanes, hidden and restricted ones labelled, with their blog\'s name', async () => {
      const HIDDEN_BLOG = 'H'.repeat(44)
      // Each blog the page names is read by id, a hidden one kept; a deleted one reads as null.
      const blogs = new Map([[BLOG, libBlog()], [HIDDEN_BLOG, libBlog({ id: HIDDEN_BLOG, name: 'Hidden blog', ...hide() })]])
      m.blogService.getBlog.mockImplementation(async (id: string) => blogs.get(id) ?? null)
      m.blogPostService.getOwnerPostsPage.mockResolvedValue({
        posts: [
          v10Post(),
          v10Post({ id: 'P2'.padEnd(44, 'x'), live: 2 }),
          v10Post({ id: 'P3'.padEnd(44, 'x'), ...hide() }),
          v10Post({ id: 'P4'.padEnd(44, 'x'), blogId: HIDDEN_BLOG }),
          v10Post({ id: 'P5'.padEnd(44, 'x'), blogId: 'G'.repeat(44) }),
        ],
        nextCursor: undefined,
      })
      const { items } = await blogReads.myPosts()
      expect(m.blogService.getBlog.mock.calls.map(([id]) => id)).toEqual([BLOG, HIDDEN_BLOG, 'G'.repeat(44)])
      expect(m.blogService.getBlog).toHaveBeenCalledWith(BLOG, { throwOnError: true })
      // Not the owner's first page of blogs (an older blog may be past it), nor `getMany` (it drops hidden ones).
      expect(m.blogService.getBlogsByOwner).not.toHaveBeenCalled()
      expect(m.blogService.getMany).not.toHaveBeenCalled()
      expect(items.map(post => [post.title, post.blogName, post.moderation])).toEqual([
        ['Title', 'My blog', undefined],
        ['Title', 'My blog', { hidden: false, restricted: true }],
        ['Title', 'My blog', { restricted: false, ...label }],
        // A hidden blog's post is still the author's to find; a deleted blog's keeps no name.
        ['Title', 'Hidden blog', undefined],
        ['Title', null, undefined],
      ])
    })
  })

  describe("the author's management reads (settings, the editor)", () => {
    it("reads the author's own hidden blog and post whole, labelled", async () => {
      m.blogService.getBlog.mockResolvedValue(libBlog(hide()))
      expect(await blogReads.manage(BLOG)).toMatchObject({ name: 'My blog', description: 'About things', moderation: { restricted: false, ...label } })
      m.blogPostService.getPostBySlug.mockResolvedValue(v10Post({ live: 2, ...hide() }))
      expect(await blogReads.managePost(BLOG, 'title')).toMatchObject({
        title: 'Title', content: [{ type: 'paragraph', content: 'Hello there' }], moderation: { restricted: true, ...label },
      })
    })

    it("reads anyone else's hidden blog and post as the public does, withheld", async () => {
      m.viewer = 'READER'
      m.blogService.getBlog.mockResolvedValue(libBlog(hide()))
      expect(await blogReads.manage(BLOG)).toMatchObject({ ownerId: AUTHOR, name: '', moderation: { withheld: true } })
      m.blogPostService.getPostBySlug.mockResolvedValue(v10Post(hide()))
      expect(await blogReads.managePost(BLOG, 'title')).toMatchObject(withheldPost)
    })

    it('needs a signed-in viewer', async () => {
      m.viewer = null
      await expect(blogReads.manage(BLOG)).rejects.toBeTruthy()
      await expect(blogReads.managePost(BLOG, 'title')).rejects.toBeTruthy()
    })
  })

  describe('on an archival build (every lane)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    })

    it('shows a hidden post read by id or address in full, labelled, and marks a restricted author\'s post', async () => {
      m.blogPostService.getOrThrow.mockResolvedValue(v10Post({ live: 2, ...hide() }))
      expect(await blogReads.post(POST)).toMatchObject({ title: 'Title', content: [{ type: 'paragraph', content: 'Hello there' }], moderation: { restricted: true, ...label } })
      m.blogPostService.getPostBySlug.mockResolvedValue(v10Post({ live: 2 }))
      expect((await blogReads.postBySlug(BLOG, 'title'))?.moderation).toEqual({ hidden: false, restricted: true })
    })

    it('labels a hidden blog and comment instead of withholding them', async () => {
      m.blogService.getBlog.mockResolvedValue(libBlog(hide()))
      expect(await blogReads.get(BLOG)).toMatchObject({ name: 'My blog', moderation: { restricted: false, ...label } })
      m.blogCommentService.getCommentsByPost.mockResolvedValue([{ id: 'C2', ownerId: AUTHOR, blogPostId: POST, createdAt: new Date(2), content: 'spam', ...hide() }])
      expect((await blogReads.comments(POST))[0]).toMatchObject({ content: 'spam', moderation: { restricted: false, ...label } })
    })
  })
})
