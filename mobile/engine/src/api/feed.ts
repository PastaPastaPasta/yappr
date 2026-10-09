import { hashtagsAreInline, likesAreIndexOnly, postsHaveLanguage } from '@/lib/contract-topology'
import { enrichPostsWithRepostsAndQuotes } from '@/lib/feed/enrich-posts'
import { loadFollowingFeed, type FollowingFeedWindow } from '@/lib/feed/load-following-feed'
import { loadForYouFeed } from '@/lib/feed/load-for-you-feed'
import { getFeedItemTimestamp, sortFeedByTimestamp, transformRawPost } from '@/lib/feed/transform-raw-post'
import { TtlMap } from '@/lib/caches/ttl-map'
import { queryPostsByOwnersSince, queryPostsSince } from '@/lib/services/document-service'
import { followService } from '@/lib/services/follow-service'
import { hashtagService } from '@/lib/services/hashtag-service'
import { postService } from '@/lib/services/post-service'
import { topLikedPostsByAuthorsHydrated, topLikedPostsHydrated } from '@/lib/services/ranked-likes'
import { CASHTAG_SUFFIX, cashtagDisplayToStorage, hashtagDisplayToStorage } from '@/lib/post-helpers'
import { useSettingsStore } from '@/lib/store'
import type { Post } from '@/lib/types'
import { cursorInt, decodeCursor } from '../dto/cursor'
import { listToDTOs, notSupported, requireViewer, rereadQuotedPosts, viewerId, visibleDTOs } from '../dto/hydrate'
import { nextPage, onePage, pageAfter, pageOfList } from '../dto/paging'
import { RpcError } from '../protocol/envelope'
import { NewPostsRetry, selectNewPosts } from './new-posts-retry'
import type { Page, PostDTO, RankingWindow } from './dto'

/**
 * Feed reads: the engine-side twins of web's home feed (`hooks/use-feed-data.ts`,
 * `hooks/use-top-feed.ts`) and tag page (`app/hashtag/page.tsx`), calling the
 * same lib functions, then mapping to DTOs. Topology differences stay in lib;
 * a sort the topology cannot serve rejects with `NOT_SUPPORTED`
 * (`engine.info().capabilities.rankings`).
 *
 * Not mirrored: web's page cache, new-post polling and pending-post merge,
 * which belong to the host.
 */

export type FeedTab = 'forYou' | 'following'

export interface HomeQuery {
  tab: FeedTab
  /** Default `recent`. */
  sort?: 'recent' | 'top'
  /** Top only; default `all`. */
  window?: RankingWindow
  cursor?: string | null
}

export interface HashtagQuery {
  /** Storage form (`dash`, `dash_cashtag`) or display form (`#Dash`, `$DASH`), normalised as web's links do. */
  tag: string
  sort?: 'recent' | 'top'
  window?: RankingWindow
  cursor?: string | null
}

/** `hooks/use-top-feed.ts`: each load-more widens the ranking by a page, up to Drive's query limit. */
const TOP_PAGE = 20
const MAX_RANKED = 100
/** `app/hashtag/page.tsx`. */
const TAG_PAGE = 50
/** `use-feed-data.ts` `checkForNewPosts`. */
const NEW_POSTS_OVERLAP_MS = 2000
const NEW_POSTS_LIMIT = 50

const feedLanguage = () => (postsHaveLanguage() ? useSettingsStore.getState().feedLanguage : undefined)

/** v2 tag pages read every postHashtag document for the tag (each post with everyone who tagged it); one scroll pages that list. */
/** Per viewer, the start of an incomplete Following new-posts scan still being read again. */
const newPostsRetry = new NewPostsRetry()

const tagEntries = new TtlMap<string, { postId: string; taggers: Set<string> }[]>(60_000)

/**
 * A tag in storage form, as web's links carry it: lowercase, `#` dropped,
 * `$TICKER` as the cashtag storage form (`dash_cashtag`).
 */
function storageTag(input: string): string {
  const tag = input.trim()
  return tag.startsWith('$') ? cashtagDisplayToStorage(tag) : hashtagDisplayToStorage(tag)
}

function forYou(cursor: string | null | undefined): Promise<Page<PostDTO>> {
  const language = feedLanguage()
  // The language is in the kind: a cursor from another language's index is a BAD_CURSOR.
  return pageAfter(`forYou:${language ?? ''}`, cursor,
    after => loadForYouFeed({ startAfter: after, feedLanguage: language, currentUserId: viewerId() ?? undefined }),
    async page => ({
      // Repost attribution and the quotes the page did not attach; drops tombstones.
      items: await listToDTOs(await enrichPostsWithRepostsAndQuotes(sortFeedByTimestamp(page.posts)), page.preloaded),
      next: page.hasMore ? page.cursor : null,
    }))
}

/**
 * The Following feed: lib walks empty windows back to 2025-01-01 itself,
 * attaches quotes and followed users' reposts. lib reports a failure as an
 * empty last page (web shows "nothing yet"); the engine rejects instead, so
 * the host can offer a retry.
 */
async function following(cursor: string | null | undefined): Promise<Page<PostDTO>> {
  const userId = requireViewer('The Following feed')
  const kind = `following:${userId}`
  const fields = decodeCursor<{ start: number; end: number; hours: number }>(cursor, kind)
  const timeWindow: FollowingFeedWindow | undefined = fields
    ? { start: new Date(cursorInt(fields.start)), end: new Date(cursorInt(fields.end)), windowHours: cursorInt(fields.hours) }
    : undefined
  let batch: { posts: Post[]; next: FollowingFeedWindow | null } = { posts: [], next: null }
  // lib calls enrichProgressively after every successful load (even an empty
  // one) and skips it only in its catch, so that call tells success from a
  // swallowed failure.
  let loaded = false
  await loadFollowingFeed({
    userId,
    timeWindow,
    forceRefresh: false,
    onBatchReady: (posts, next) => { batch = { posts, next } },
    enrichProgressively: () => { loaded = true },
  })
  if (!loaded) throw new RpcError('The Following feed could not be read', 'NETWORK')
  const { next } = batch
  return nextPage(await listToDTOs(batch.posts), kind,
    next && { start: next.start.getTime(), end: next.end.getTime(), hours: next.windowHours })
}

/**
 * The Top view: a proved top-K ranking re-read with a larger K for each
 * page. Only ids not returned before come back, so a like-count shuffle
 * between reads never repeats or reorders a card (`use-top-feed.ts`).
 */
async function top(query: HomeQuery): Promise<Page<PostDTO>> {
  if (!likesAreIndexOnly()) throw notSupported('The Top sort')
  const window = query.window ?? 'all'
  // The cursor kind names the ranking and the viewer (Following's authors, the
  // `seen` ids), so a cursor from another tab, window or account is a BAD_CURSOR.
  const kind = `top:${query.tab}:${window}:${viewerId() ?? ''}`
  const fields = decodeCursor<{ limit: number; seen: string[] }>(query.cursor, kind)
  const limit = fields ? Math.min(cursorInt(fields.limit) + TOP_PAGE, MAX_RANKED) : TOP_PAGE
  const seen = new Set(fields?.seen ?? [])
  // A widening bypasses the minute-long ranked cache, as web's load-more does.
  const options = { limit, window, force: fields !== null, throwOnError: true }
  const ranked = query.tab === 'following'
    ? await topLikedPostsByAuthorsHydrated({ ...options, authorIds: await followService.getFollowingIds(requireViewer('The Following feed')) })
    : await topLikedPostsHydrated(options)
  // Judged on the ranked page, not the filtered one, as on web.
  const hasMore = ranked.length >= limit && limit < MAX_RANKED
  return nextPage(await visibleDTOs(ranked.filter(post => !seen.has(post.id))), kind,
    hasMore ? { limit, seen: [...seen, ...ranked.map(post => post.id)] } : null)
}

function hashtagRecentInline(tag: string, cursor: string | null | undefined): Promise<Page<PostDTO>> {
  return pageAfter(`tag:${tag}`, cursor,
    after => postService.queryForDisplay({
      where: [['hashtag', '==', tag], ['$createdAt', '>', 0]],
      orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']],
      limit: TAG_PAGE,
      ...(after ? { startAfter: after } : {}),
    }),
    async page => ({
      items: await listToDTOs(page.documents.filter(post => !post.deleted), page.preloaded),
      // The cursor advances over the raw page, including posts the viewer filters hide.
      next: page.documents.length === TAG_PAGE ? page.documents[TAG_PAGE - 1].id : null,
    }))
}

/** v2: the tag's postHashtag documents, then the posts, kept only where the tagger wrote the post. */
function hashtagRecentIndexed(tag: string, cursor: string | null | undefined): Promise<Page<PostDTO>> {
  return pageOfList({
    kind: 'tagIds',
    key: tag,
    cursor,
    size: TAG_PAGE,
    cache: tagEntries,
    load: async () => {
      // Anyone can tag any post; a post counts when one of its taggers wrote it (web's authenticTags).
      const byPost = new Map<string, { postId: string; taggers: Set<string> }>()
      for (const doc of await hashtagService.getPostIdsByHashtag(tag)) {
        const entry = byPost.get(doc.postId) ?? { postId: doc.postId, taggers: new Set<string>() }
        entry.taggers.add(doc.$ownerId)
        byPost.set(doc.postId, entry)
      }
      return Array.from(byPost.values())
    },
    hydrate: async (entries) => {
      const taggersOf = new Map(entries.map(entry => [entry.postId, entry.taggers]))
      const posts = (await postService.getPostsByIds(entries.map(entry => entry.postId), { skipEnrichment: true }))
        .filter(post => taggersOf.get(post.id)?.has(post.author.id) && !post.deleted)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return listToDTOs(posts)
    },
  })
}

export const feed = {
  /**
   * The home feed. **For You, recent:** `loadForYouFeed` with the persisted
   * feed language (where posts carry one), sorted, repost attribution and
   * quotes, then batch enrichment, blocked authors and the NSFW `hide`
   * preference filtered. **Following, recent:** `loadFollowingFeed`'s time
   * windows (signed in). **Top:** the proved ranking (`rankings` capability).
   */
  async home(query: HomeQuery): Promise<Page<PostDTO>> {
    if (!query.cursor) rereadQuotedPosts()
    if (query.sort === 'top') return top(query)
    return query.tab === 'following' ? following(query.cursor) : forYou(query.cursor)
  },

  /**
   * Posts newer than `since` for the "Show N new posts" pill, as web polls
   * them every 15 s: `queryPostsSince` (For You, same language) or
   * `queryPostsByOwnersSince` (Following), from 2 s before `since`, at most
   * 50. Pass the ids already on screen from that overlap in `knownIds`;
   * without them, posts at or before `since` are left out.
   *
   * `complete` is false when the Following scan stopped early and may have
   * missed posts older than its newest. The engine then keeps reading from
   * where that scan started, even after `since` moves past it, and offers
   * the missed posts it finds there on every check until they come back in
   * `knownIds` (inserted) and a check is complete.
   */
  async checkNew(query: { tab: FeedTab; since: Date; knownIds?: string[] }): Promise<{ count: number; posts: PostDTO[]; complete: boolean }> {
    const sinceTime = query.since.getTime()
    const sinceMs = Math.max(0, sinceTime - NEW_POSTS_OVERLAP_MS)
    let raw: Record<string, unknown>[]
    let complete = true
    let retryKey: string | null = null
    let fromMs = sinceMs
    if (query.tab === 'following') {
      const viewer = requireViewer('The Following feed')
      retryKey = viewer
      fromMs = newPostsRetry.scanFrom(viewer, sinceMs)
      const ids = await followService.getFollowingIdsCached(viewer)
      if (ids.length > 0) ({ posts: raw, complete } = await queryPostsByOwnersSince(ids, fromMs, NEW_POSTS_LIMIT))
      else raw = []
    } else {
      raw = await queryPostsSince(sinceMs, NEW_POSTS_LIMIT, feedLanguage() || 'en')
    }
    const { offered, recovered } = selectNewPosts(sortFeedByTimestamp(raw.map(transformRawPost)), getFeedItemTimestamp, {
      since: sinceTime,
      overlapFrom: sinceMs,
      known: query.knownIds ? new Set(query.knownIds) : null,
    })
    const posts = await listToDTOs(await enrichPostsWithRepostsAndQuotes(offered))
    // Only once the answer is built: a failed one leaves the retry state as it was.
    if (retryKey !== null) newPostsRetry.settle(retryKey, fromMs, complete, recovered)
    return { count: posts.length, posts, complete }
  },

  /**
   * A tag page. **Recent:** v9/v10 query `post.tagAndTime` (50 a page,
   * composite-enriched); v2 lists the tag's postHashtag documents and pages
   * them in memory. **Top:** the tag-pinned proved ranking, one page.
   */
  async hashtag(query: HashtagQuery): Promise<Page<PostDTO>> {
    const tag = storageTag(query.tag)
    if (!tag || tag === CASHTAG_SUFFIX) throw new RpcError('No tag given', 'BAD_REQUEST')
    if (!query.cursor) rereadQuotedPosts()
    if (query.sort === 'top') {
      if (!likesAreIndexOnly()) throw notSupported('The Top sort')
      const ranked = await topLikedPostsHydrated({ hashtag: tag, limit: TOP_PAGE, window: query.window ?? 'all' })
      return onePage(await visibleDTOs(ranked))
    }
    return hashtagsAreInline() ? hashtagRecentInline(tag, query.cursor) : hashtagRecentIndexed(tag, query.cursor)
  },
}
