import { expect, it } from 'vitest'
import { postsHaveLanguage } from '@/lib/contract-topology'
import { loadForYouFeed } from '@/lib/feed/load-for-you-feed'
import { sortFeedByTimestamp } from '@/lib/feed/transform-raw-post'
import { encodeCursor } from '../../../src/dto/cursor'
import { page, postDTO } from '../../../src/dto/validate'
import { capabilities, describeRead, engine, expectCode, expectValid, sampleFeed, timed } from './harness'

describeRead('feed', 'feed', () => {
  it('reads the first For You page: valid, enriched, newest first, signed out', async () => {
    const first = await timed('feed.home forYou', () => engine.feed.home({ tab: 'forYou' }))
    expectValid(page(postDTO), first, 'page')
    expect(first.items.length).toBeGreaterThan(0)
    for (const post of first.items) {
      expect(post.author.resolved).toBe(true)
      expect(post.viewer).toBeUndefined()
      expect(post.deleted).toBe(false)
      // A bare repost never surfaces as an empty post: it carries its target.
      if (post.bareRepost) expect(post.quoted ?? post.quotedRemoved).toBeTruthy()
    }
    const times = first.items.map(post => (post.repostTimestamp ?? post.createdAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(first.items.some(post => post.author.username)).toBe(true)
    expect(first.hasMore).toBe(first.cursor !== null)
  })

  it('returns the ids lib loadForYouFeed returns for page 1, in order (web parity)', async () => {
    const [engineIds, libPage] = await Promise.all([
      engine.feed.home({ tab: 'forYou' }).then(result => result.items.map(post => post.id)),
      loadForYouFeed({ feedLanguage: postsHaveLanguage() ? 'en' : undefined }),
    ])
    // The engine drops tombstones (enrichPostsWithRepostsAndQuotes) as web's feed does.
    expect(engineIds).toEqual(sortFeedByTimestamp(libPage.posts).filter(post => !post.deleted).map(post => post.id))
  })

  it('pages with the cursor without repeats, and ends cleanly past the last post (dashpay/platform#5244)', async () => {
    const first = await engine.feed.home({ tab: 'forYou' })
    const seen = new Set(first.items.map(post => post.id))
    if (first.cursor) {
      const second = await timed('feed.home forYou page 2', () => engine.feed.home({ tab: 'forYou', cursor: first.cursor }))
      expectValid(page(postDTO), second, 'page2')
      expect(second.items.some(post => seen.has(post.id))).toBe(false)
    }
    // Asking past the oldest post: on testnet evo-sdk throws a proof error for
    // this mixed-direction query instead of proving an empty page; the engine
    // reads that as the end.
    const last = first.items[first.items.length - 1]
    const past = await timed('feed.home forYou past end', () =>
      engine.feed.home({ tab: 'forYou', cursor: encodeCursor(`forYou:${postsHaveLanguage() ? 'en' : ''}`, { after: last.id }) }))
    expect(past).toEqual({ items: [], cursor: null, hasMore: false })
  })

  it('needs a session for Following and serves Top only where rankings exist', async () => {
    await expectCode(engine.feed.home({ tab: 'following' }), 'NOT_SIGNED_IN')
    await expectCode(engine.feed.checkNew({ tab: 'following', since: new Date() }), 'NOT_SIGNED_IN')
    const caps = await capabilities()
    if (!caps.rankings) {
      await expectCode(engine.feed.home({ tab: 'forYou', sort: 'top' }), 'NOT_SUPPORTED')
      await expectCode(engine.feed.hashtag({ tag: 'yappr', sort: 'top' }), 'NOT_SUPPORTED')
      return
    }
    const top = await timed('feed.home top', () => engine.feed.home({ tab: 'forYou', sort: 'top' }))
    expectValid(page(postDTO), top, 'top')
    if (top.cursor) {
      const more = await engine.feed.home({ tab: 'forYou', sort: 'top', cursor: top.cursor })
      const ids = new Set(top.items.map(post => post.id))
      expect(more.items.some(post => ids.has(post.id))).toBe(false)
      await expectCode(engine.feed.home({ tab: 'forYou', sort: 'top', window: 'today', cursor: top.cursor }), 'BAD_CURSOR')
    }
  })

  it('counts new posts for the pill: none after the newest, all of them since the start', async () => {
    const posts = await sampleFeed()
    const newest = new Date(Math.max(...posts.map(post => post.createdAt.getTime())))
    const none = await timed('feed.checkNew', () => engine.feed.checkNew({ tab: 'forYou', since: newest }))
    expect(none).toEqual({ count: 0, posts: [] })
    const known = await engine.feed.checkNew({ tab: 'forYou', since: newest, knownIds: [] })
    expect(known.posts.map(post => post.id)).toContain(posts.find(post => post.createdAt.getTime() === newest.getTime())?.id)
    const all = await engine.feed.checkNew({ tab: 'forYou', since: new Date(posts[posts.length - 1].createdAt.getTime() - 1) })
    expect(all.count).toBe(all.posts.length)
    for (const post of all.posts) expectValid(postDTO, post, 'new')
    expect(all.count).toBeGreaterThanOrEqual(posts.length)
  })

  it('reads a tag page, recent first, and rejects an empty tag', async () => {
    const tag = await timed('feed.hashtag recent', () => engine.feed.hashtag({ tag: '#yappr' }))
    expectValid(page(postDTO), tag, 'tag')
    await expectCode(engine.feed.hashtag({ tag: ' # ' }), 'BAD_REQUEST')
    // A cursor issued for one tag does not page another.
    const caps = await capabilities()
    const otherTag = caps.hashtagsInline
      ? encodeCursor('tag:dash', { after: (await sampleFeed())[0].id })
      : encodeCursor('tagIds', { key: 'dash', offset: 1 })
    await expectCode(engine.feed.hashtag({ tag: 'yappr', cursor: otherTag }), 'BAD_CURSOR')
  })
})
