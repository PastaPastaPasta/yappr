import { expect, it } from 'vitest'
import { encodeCursor } from '../../../src/dto/cursor'
import { engagementCountsDTO, engagementPage, pollDTO, postDTO, threadDTO, userSummaryDTO } from '../../../src/dto/validate'
import { capabilities, describeRead, engine, expectCode, expectValid, sampleFeed, samplePosts, timed } from './harness'

const MISSING = '11111111111111111111111111111111111111111111'

/** A sample post that has replies, likes and reposts on the live network, if any. */
async function engagedPost() {
  const posts = await samplePosts()
  return posts.find(post => post.stats.replies > 0 && post.stats.likes > 0) ?? posts[0]
}

describeRead('posts', 'posts', () => {
  it('gets one post by id, the same post the feed shows', async () => {
    const sample = (await samplePosts())[0]
    const post = await timed('posts.get', () => engine.posts.get(sample.id))
    expectValid(postDTO, post, 'post')
    expect(post).toMatchObject({ id: sample.id, content: sample.content, author: { id: sample.author.id, resolved: true } })
    expect(await engine.posts.get(MISSING)).toBeNull()
  })

  it('reads a thread: focus, replies with depth, the reply\'s own thread with its ancestors', async () => {
    const sample = await engagedPost()
    const thread = await timed('posts.thread', () => engine.posts.thread(sample.id))
    expectValid(threadDTO, thread, 'thread')
    expect(thread.focus?.id).toBe(sample.id)
    expect(thread.ancestors).toEqual([])
    expect(thread.replies.items.length).toBeGreaterThanOrEqual(sample.stats.replies > 0 ? 1 : 0)
    for (const reply of thread.replies.items) {
      expect(reply.kind).toBe('reply')
      // Top-level replies answer the focus; the author's continuation answers the previous part.
      if (reply.depth === 0 && !reply.isAuthorThread) expect(reply.parentId).toBe(sample.id)
    }
    if (thread.replies.cursor) {
      const more = await timed('posts.thread page 2', () => engine.posts.thread(sample.id, thread.replies.cursor))
      expect(more.replies.items.length).toBeGreaterThanOrEqual(thread.replies.items.length)
    }

    const reply = thread.replies.items[0]
    if (!reply) return
    const asReply = await timed('posts.get reply', () => engine.posts.get(reply.id))
    expect(asReply).toMatchObject({ id: reply.id, kind: 'reply', author: { resolved: true } })
    const replyThread = await timed('posts.thread reply', () => engine.posts.thread(reply.id))
    expectValid(threadDTO, replyThread, 'replyThread')
    expect(replyThread.focus?.id).toBe(reply.id)
    expect(replyThread.ancestors.map(post => post.id)).toContain(sample.id)
    await expectCode(engine.posts.thread(reply.id, encodeCursor(`thread:${sample.id}`, { pages: 1 })), 'BAD_CURSOR')
    expect(await engine.posts.thread(MISSING)).toEqual({ focus: null, ancestors: [], removedAncestorIds: [], replies: { items: [], cursor: null, hasMore: false } })
  })

  it('lists who liked, reposted and quoted, consistent with the counts', async () => {
    const sample = await engagedPost()
    const target = { id: sample.id, kind: sample.kind }
    const counts = await timed('posts.engagementCounts', () => engine.posts.engagementCounts(target))
    expectValid(engagementCountsDTO, counts, 'counts')
    const caps = await capabilities()
    for (const tab of ['likes', 'reposts', 'quotes'] as const) {
      const list = await timed(`posts.engagements ${tab}`, () => engine.posts.engagements(target, tab))
      expectValid(engagementPage, list, tab)
      if (tab === 'likes') expect(list.items.length).toBe(Math.min(counts.likes, 30))
      if (tab === 'reposts' && !caps.repostsAreQuotes) expect(list.items.length).toBe(Math.min(counts.reposts, 30))
      if (tab === 'quotes') for (const entry of list.items) expect(entry.quote?.id).toBeTruthy()
    }
  })

  it('reads a poll only on the configured Pollr contract', async () => {
    const withPoll = (await sampleFeed()).find(post => post.poll)
    if (withPoll?.poll) {
      const poll = await timed('posts.poll', () => engine.posts.poll({ id: withPoll.poll?.id ?? '' }))
      if (poll) expectValid(pollDTO, poll, 'poll')
    }
    // A post embedding a poll on another Pollr deployment (testnet's e2e posts) shows no poll, as on web.
    const foreign = (await sampleFeed()).find(post => post.embed && !post.poll)
    if (foreign?.embed) expect(await engine.posts.poll({ contractId: foreign.embed.contractId, id: foreign.embed.id })).toBeNull()
    expect(await timed('posts.poll missing', () => engine.posts.poll({ id: MISSING }))).toBeNull()
  })

  it('suggests mentions from 3 characters, one row per identity', async () => {
    expect(await engine.posts.mentionCandidates('@pa')).toEqual([])
    const { username } = (await sampleFeed()).find(post => post.author.username)?.author ?? {}
    if (!username) return
    const candidates = await timed('posts.mentionCandidates', () => engine.posts.mentionCandidates(`@${username.slice(0, 3)}`))
    for (const candidate of candidates) expectValid(userSummaryDTO, candidate, 'candidate')
    expect(candidates.length).toBeLessThanOrEqual(5)
    expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(candidates.length)
  })
})
