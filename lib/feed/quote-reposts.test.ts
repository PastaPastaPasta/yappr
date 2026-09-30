import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuoteBody } from './quote-reposts'

/** The descriptor is cached per module, so each topology needs a fresh registry. */
async function quoteReposts(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./quote-reposts')
}

afterEach(() => vi.unstubAllEnvs())

const bare: QuoteBody = { content: '', quotedPostId: 'target' }
const bareOfReply: QuoteBody = { content: '', quotedReplyId: 'reply' }
const withText: QuoteBody = { content: 'so true', quotedPostId: 'target' }
const withMedia: QuoteBody = { content: '', quotedPostId: 'target', media: [{ id: 'm', type: 'image', url: 'ipfs://x' }] }
const withEmbed: QuoteBody = { content: '', quotedPostId: 'target', embedId: 'poll' }
const withCiphertext: QuoteBody = { content: '', quotedPostId: 'target', encryptedContent: new Uint8Array([1]) }
const plain: QuoteBody = { content: 'hello' }
const empty: QuoteBody = { content: '' }

describe('reposts as quotes', () => {
  it('reads a quote carrying nothing of its own as a bare repost, of a post or a reply', async () => {
    const { isQuoteOnly } = await quoteReposts('v10')
    expect([bare, bareOfReply, { ...bare, content: '   ' }].map(isQuoteOnly)).toEqual([true, true, true])
    expect([withText, withMedia, withEmbed, withCiphertext, plain, empty].map(isQuoteOnly)).toEqual([false, false, false, false, false, false])
  })

  it('renders bare reposts as reposts on v10 only, and never a deleted one', async () => {
    const v10 = await quoteReposts('v10')
    expect(v10.isBareRepost(bare)).toBe(true)
    expect(v10.isBareRepost(withText)).toBe(false)
    expect(v10.isBareRepost({ ...bare, deleted: true })).toBe(false)
    // v9 and v2 have repost documents; an empty quote there is just an empty quote.
    expect((await quoteReposts('v9')).isBareRepost(bare)).toBe(false)
    expect((await quoteReposts('v2')).isBareRepost(bare)).toBe(false)
  })

  it('splits a quote list into reposts and quotes, keeping order', async () => {
    const { splitRepostsAndQuotes } = await quoteReposts('v10')
    const list = [withText, bare, withMedia, bareOfReply]
    expect(splitRepostsAndQuotes(list)).toEqual({ reposts: [bare, bareOfReply], quotes: [withText, withMedia] })
    expect(splitRepostsAndQuotes([])).toEqual({ reposts: [], quotes: [] })
  })

  it('classifies notifications and own quotes the same way', async () => {
    const { ownQuoteOf, quoteNotificationType, quotedTargetIdOf } = await quoteReposts('v10')
    expect(quoteNotificationType(bare)).toBe('repost')
    expect(quoteNotificationType(withText)).toBe('quote')
    expect(ownQuoteOf({ ...bare, id: 'mine' })).toEqual({ id: 'mine', bare: true })
    expect(ownQuoteOf({ ...withText, id: 'mine' })).toEqual({ id: 'mine', bare: false })
    expect([quotedTargetIdOf(bare), quotedTargetIdOf(bareOfReply), quotedTargetIdOf(plain)]).toEqual(['target', 'reply', undefined])
  })

  it('collapses a newest-first feed to one card per reposted target (v10)', async () => {
    const { collapseReposts } = await quoteReposts('v10')
    const repostBy = (id: string) => ({ ...bare, id })
    const original = { ...plain, id: 'target' }
    const quote = { ...withText, id: 'q1' }
    const feed = [repostBy('r3'), quote, repostBy('r2'), { ...plain, id: 'other' }, repostBy('r1'), original]
    const collapsed = collapseReposts(feed)
    // The newest repost stays in place and counts the two older reposters; the
    // target itself and the older reposts go; a quote with text stays.
    expect(collapsed.map((post) => post.id)).toEqual(['r3', 'q1', 'other'])
    expect(collapsed[0].repostedByOthers).toBe(2)
    expect(collapsed[1].repostedByOthers).toBeUndefined()
    // A target shown before any repost of it keeps its card; a lone repost stays as is.
    expect(collapseReposts([original, repostBy('r9')]).map((post) => post.id)).toEqual(['target'])
    expect(collapseReposts([repostBy('r1')])[0].repostedByOthers).toBeUndefined()
  })

  it('leaves v9 feeds alone: an empty quote there is not a repost', async () => {
    const { collapseReposts } = await quoteReposts('v9')
    const feed = [{ ...bare, id: 'a' }, { ...bare, id: 'b' }]
    expect(collapseReposts(feed)).toEqual(feed)
  })

  it('shows a bare repost as its target\'s author, so block and hide filters see through it', async () => {
    const { repostedAuthorIdOf } = await quoteReposts('v10')
    const { filterHiddenSensitive } = await import('@/lib/sensitive-content')
    const author = (id: string) => ({ id, username: '', displayName: '', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(0) })
    const target = { id: 'target', author: author('blocked'), content: 'nsfw', createdAt: new Date(0), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, sensitive: true }
    const repost = { ...target, id: 'repost', author: author('friend'), content: '', sensitive: undefined, quotedPostId: 'target', quotedPost: target }
    expect(repostedAuthorIdOf({ ...repost, quotedPostOwnerId: 'owner' })).toBe('owner')
    expect(repostedAuthorIdOf(repost)).toBe('blocked')
    expect(repostedAuthorIdOf(target)).toBeNull()
    // 'hide' drops the repost of a sensitive target, unless the target is the viewer's.
    expect(filterHiddenSensitive([repost], 'hide', 'friend')).toEqual([])
    expect(filterHiddenSensitive([repost], 'hide', 'blocked')).toEqual([repost])
    expect(filterHiddenSensitive([repost], 'blur', 'friend')).toEqual([repost])
    // v9 has no bare reposts: the target's author is not consulted.
    expect((await quoteReposts('v9')).repostedAuthorIdOf(repost)).toBeNull()
  })
})
