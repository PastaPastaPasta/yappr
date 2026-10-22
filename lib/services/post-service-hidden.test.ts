/**
 * v18 "hide, don't delete": every Post and Reply the services build carries the
 * moderators' marks, and the lists that hydrate posts by id (not through a
 * laned listing) drop a hidden one on a default build. A single post opened by
 * id keeps its marks, and the quote-target resolver gets hidden targets back so
 * it can mark the quoting card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

const OWNER = '11111111111111111111111111111113'
const raw = (id: string, fields: Record<string, unknown> = {}) => ({
  $id: id, $ownerId: OWNER, $createdAt: 1_790_000_000_000, content: id, live: 1, ...fields,
})
const HIDDEN = { mod: 1, modLabel: 7, $moderatedBy: OWNER, $moderatedAt: 1_790_000_100_000 }

async function services(env: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v18')
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { postService } = await import('./post-service')
  const { replyService } = await import('./reply-service')
  return { postService, replyService }
}

/** getMany answers with posts built from `docs` by the service's own transform. */
async function withStoredPosts(docs: Record<string, unknown>[], env?: Record<string, string>) {
  const { postService, replyService } = await services(env)
  const posts = docs.map((doc) => postService.fromDocument(doc))
  vi.spyOn(postService, 'getMany').mockResolvedValue(posts)
  return { postService, replyService, posts }
}

beforeEach(() => query.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe('the marks on a post and a reply', () => {
  it('carry mod, its label and who set it, and lane 2 as restricted', async () => {
    const { postService, replyService } = await services()

    expect(postService.fromDocument(raw('p', HIDDEN)).moderation).toEqual({
      mod: 1, modLabel: 7, moderatedBy: OWNER, moderatedAt: 1_790_000_100_000,
    })
    expect(postService.fromDocument(raw('p', { live: 2 })).moderation).toEqual({ restricted: true })
    expect(replyService.fromDocument(raw('r', { ...HIDDEN, live: 2, parentId: 'p', parentOwnerId: OWNER })).moderation)
      .toMatchObject({ mod: 1, modLabel: 7, restricted: true })
  })

  it('are absent on a listed post, and survive a reply shown as a post', async () => {
    const { postService, replyService } = await services()
    const { replyToPost } = await import('./post-service')

    expect(postService.fromDocument(raw('p'))).not.toHaveProperty('moderation')
    const reply = replyService.fromDocument(raw('r', { ...HIDDEN, parentId: 'p', parentOwnerId: OWNER }))
    expect(replyToPost(reply).moderation).toMatchObject({ mod: 1 })
  })
})

describe('lists that hydrate posts by id', () => {
  const docs = [raw('shown'), raw('hidden', HIDDEN), raw('held', { mod: 2, modLabel: 2 })]

  it('getPostsByIds drops hidden posts and posts on legal hold, in order', async () => {
    const { postService } = await withStoredPosts(docs)

    const posts = await postService.getPostsByIds(['shown', 'hidden', 'held'], { skipEnrichment: true })

    expect(posts.map((post) => post.id)).toEqual(['shown'])
  })

  it('getPostsByIds keeps them, marked, when asked (the quote resolver) and on an archival build', async () => {
    const { postService } = await withStoredPosts(docs)
    const kept = await postService.getPostsByIds(['shown', 'hidden'], { skipEnrichment: true, keepHidden: true })
    expect(kept.map((post) => [post.id, post.moderation?.mod])).toEqual([['shown', undefined], ['hidden', 1]])

    const archive = await withStoredPosts(docs, { NEXT_PUBLIC_MODERATION_VIEW: 'all' })
    const all = await archive.postService.getPostsByIds(['shown', 'hidden', 'held'], { skipEnrichment: true })
    expect(all.map((post) => post.id)).toEqual(['shown', 'hidden', 'held'])
  })

  it('getPostsByIdsForDisplay drops hidden posts', async () => {
    const { postService, posts } = await withStoredPosts(docs)
    vi.spyOn(postService, 'queryForDisplay').mockResolvedValue({ documents: posts, preloaded: undefined })

    const page = await postService.getPostsByIdsForDisplay(['shown', 'hidden'])

    expect(page.posts.map((post) => post.id)).toEqual(['shown'])
  })

  it('fetchQuotedTargets hands hidden targets back with their marks, so the card that quotes one can say hidden', async () => {
    const { postService } = await withStoredPosts(docs)

    const targets = await postService.fetchQuotedTargets({ postIds: ['shown', 'hidden'], replyIds: [], blogPostIds: [] })

    expect(targets.map((post) => [post.id, post.moderation?.mod])).toEqual([['shown', undefined], ['hidden', 1]])
  })

  it('fetchPostsOrReplies drops them unless kept, without probing the hidden id as a reply', async () => {
    const { postService, replyService } = await withStoredPosts(docs)
    const replies = vi.spyOn(replyService, 'getRepliesByIds').mockResolvedValue([])

    expect((await postService.fetchPostsOrReplies(['shown', 'hidden'])).map((post) => post.id)).toEqual(['shown'])
    expect((await postService.fetchPostsOrReplies(['shown', 'hidden'], { keepHidden: true })).map((post) => post.id)).toEqual(['shown', 'hidden'])
    expect(replies).not.toHaveBeenCalled()
  })

  it('getPostById still returns a hidden post with its marks: the page decides how to show it', async () => {
    const { postService, posts } = await withStoredPosts(docs)
    vi.spyOn(postService, 'get').mockResolvedValue(posts[1])

    const post = await postService.getPostById('hidden', { skipEnrichment: true })

    expect(post?.moderation).toMatchObject({ mod: 1, modLabel: 7 })
  })
})

describe('the quote list', () => {
  it('leaves a hidden quote out, and keeps it on an archival build', async () => {
    const quoting = [raw('q1', { quotedPostId: 'T' }), raw('q2', { quotedPostId: 'T', ...HIDDEN })]
    const { postService } = await services()
    query.mockResolvedValue(quoting)
    const target = 'T'

    const { fetchQuotePosts } = await import('./post-query-helpers')
    const listed = await fetchQuotePosts(target, 'quotedPostId', 'contract', (doc) => postService.fromDocument(doc), { limit: 10 })
    expect(listed.map((post) => post.id)).toEqual(['q1'])

    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    const archive = await fetchQuotePosts(target, 'quotedPostId', 'contract', (doc) => postService.fromDocument(doc), { limit: 10 })
    expect(archive.map((post) => post.id).sort()).toEqual(['q1', 'q2'])
  })
})
