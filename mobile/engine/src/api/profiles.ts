import { TtlMap } from '@/lib/caches/ttl-map'
import { likesAreIndexOnly, repostsAreQuotes } from '@/lib/contract-topology'
import { fetchReplyParents } from '@/lib/feed/resolve-reply-parents'
import { byNewestActivity, resolveUserReposts } from '@/lib/feed/resolve-user-reposts'
import { generateAvatarSvg } from '@/lib/services/avatar-generator'
import { blockService } from '@/lib/services/block-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { followService } from '@/lib/services/follow-service'
import { identityService } from '@/lib/services/identity-service'
import { mentionService, type PostMentionDocument } from '@/lib/services/mention-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { topLikedPostsHydrated } from '@/lib/services/ranked-likes'
import { replyService } from '@/lib/services/reply-service'
import { repostService } from '@/lib/services/repost-service'
import { loadUserStats } from '@/lib/services/social-stats-service'
import { DICEBEAR_STYLES, unifiedProfileService } from '@/lib/services/unified-profile-service'
import type { Post } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import {
  assertAtMost, avatarOf, listToDTOs, loadUserSummaries, notSupported, toPostDTOs, viewerId, visibleDTOs, withLoadingAuthor,
} from '../dto/hydrate'
import { onePage, pageAfter, pageOfList } from '../dto/paging'
import {
  toProfileDTO,
  type Page, type PostDTO, type ProfileDTO, type ProfileReplyDTO, type RankingWindow, type UserSummaryDTO,
} from './dto'

export type ProfileTab = 'posts' | 'replies' | 'top' | 'mentions'

export interface ProfilePostsQuery {
  id: string
  tab: ProfileTab
  /** Top only; default `all`. */
  window?: RankingWindow
  cursor?: string | null
}

/** Base58 of 32 bytes: 43 or 44 characters. */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
/** `app/user/page.tsx` and `hooks/use-profile-replies.ts`. */
const POSTS_PAGE = 50
const REPLIES_PAGE = 50
/** `hooks/use-profile-tabs.ts` `loadTop`. */
const TOP_LIMIT = 10
/** Mentions are read whole on web; the engine pages them. */
const MENTIONS_PAGE = 20

const mentionLists = new TtlMap<string, PostMentionDocument[]>(60_000)
/** Posts-tab reposts older than the pages shown so far, per profile (one scroll). */
const heldReposts = new TtlMap<string, Post[]>(10 * 60_000)

/**
 * The Posts tab (`app/user/page.tsx`): the user's posts, composite-enriched
 * on the first page, plus (off v10, where reposts are posts) everything they
 * reposted, newest activity first. Later pages continue the posts only.
 */
function postsTab(id: string, cursor: string | null | undefined): Promise<Page<PostDTO>> {
  const activity = (post: Post) => (post.repostTimestamp ?? post.createdAt).getTime()
  return pageAfter(`profilePosts:${id}`, cursor,
    after => postService.getUserPosts(id, { limit: POSTS_PAGE, forDisplay: after === undefined, ...(after ? { startAfter: after } : {}) }),
    async (result, after) => {
      const isLast = result.documents.length < POSTS_PAGE
      const oldest = result.documents[result.documents.length - 1]
      // Reposts are read once, with the first page; each page takes those newer
      // than its oldest post and the last page the rest, so they land where
      // web's re-sorted list puts them.
      let held = heldReposts.get(id) ?? []
      if (after === undefined) held = repostsAreQuotes() ? [] : await userReposts(id)
      const shown = isLast || !oldest ? held : held.filter(post => activity(post) >= oldest.createdAt.getTime())
      heldReposts.prune()
      heldReposts.set(id, held.filter(post => !shown.includes(post)))
      const posts = [...result.documents.map(withLoadingAuthor), ...shown].sort(byNewestActivity)
      return {
        items: await listToDTOs(posts, result.preloaded, { dropBlocked: false }),
        next: isLast || !oldest ? null : oldest.id,
      }
    },
    // A continuation past the last post (dashpay/platform#5244) still flushes the held reposts.
    { documents: [] })
}

/** Everything `id` reposted (off v10). Reposts decorate the tab: a failed read shows none, as on web. */
async function userReposts(id: string): Promise<Post[]> {
  return repostService.getUserReposts(id)
    .then(async found => resolveUserReposts(id, found, (await unifiedProfileService.getProfile(id))?.displayName || `User ${id.slice(-6)}`))
    .catch(() => [])
}

/** The Replies tab (`hooks/use-profile-replies.ts`): replies newest first, each with the post or reply it answers. */
function repliesTab(id: string, cursor: string | null | undefined): Promise<Page<ProfileReplyDTO>> {
  return pageAfter(`profileReplies:${id}`, cursor,
    after => replyService.getUserReplies(id, { limit: REPLIES_PAGE, skipEnrichment: true, ...(after ? { startAfter: after } : {}) }),
    async (result) => {
      const replies = result.documents.map(reply => withLoadingAuthor(replyToPost(reply)))
      // The parents are context: a failed lookup leaves the cards without it, as on web.
      const { parents, missing } = await fetchReplyParents(replies).catch(() => ({ parents: new Map<string, Post>(), missing: new Map() }))
      const parentList = Array.from(new Map(Array.from(parents.values(), post => [post.id, post])).values())
      const enriched = await postService.enrichPostsBatch([...replies, ...parentList.map(withLoadingAuthor)])
      const replyDTOs = await visibleDTOs(enriched.slice(0, replies.length), { dropBlocked: false })
      const parentDTOs = new Map((await toPostDTOs(enriched.slice(replies.length))).map(dto => [dto.id, dto]))
      return {
        items: replyDTOs.map((dto): ProfileReplyDTO => {
          const parent = parentDTOs.get(parents.get(dto.id)?.id ?? '')
          return { ...dto, ...(parent ? { parent } : {}), parentRemoved: missing.has(dto.id) }
        }),
        next: result.nextCursor,
      }
    })
}

/** The Mentions tab: every mention read once, newest first, then the authentic mentioning posts a page at a time. */
function mentionsTab(id: string, cursor: string | null | undefined): Promise<Page<PostDTO>> {
  return pageOfList({
    kind: 'mentions',
    key: id,
    cursor,
    size: MENTIONS_PAGE,
    cache: mentionLists,
    load: async () => (await mentionService.getPostsMentioningUser(id)).sort((a, b) => b.$createdAt - a.$createdAt),
    hydrate: async (slice) => {
      const { posts, preloaded } = await mentionService.loadMentioningPosts(slice)
      return listToDTOs(posts.map(withLoadingAuthor), preloaded, { dropBlocked: false })
    },
  })
}

export const profiles = {
  /**
   * A profile by identity id or DPNS name (`alice`, `alice.dash`, `@alice`),
   * as web's /user page loads it: stats, the profile document, every name
   * and, signed in, the viewer's follow and block status. An identity
   * without a profile document is named by its DPNS label (#605). Rejects
   * when the profile read failed rather than reporting "no profile". `null`
   * when the identity does not exist, or for a name DPNS did not resolve:
   * lib's `resolveIdentity` reports an unreachable DPNS as "not found" too,
   * so a `null` for a name may be transient.
   */
  async get(identityIdOrName: string): Promise<ProfileDTO | null> {
    const input = identityIdOrName.trim().replace(/^@/, '')
    const id = IDENTITY_ID.test(input) ? input : await dpnsService.resolveIdentity(input)
    if (!id) return null
    const viewer = viewerId()
    const other = viewer && viewer !== id ? viewer : null
    const [stats, profile, usernames, follows, blocks] = await Promise.all([
      loadUserStats(id),
      unifiedProfileService.getProfile(id),
      dpnsService.getAllUsernamesSorted(id),
      other ? followService.isFollowing(id, other) : false,
      // The block status decorates the header; an unreadable block list is `null`, not a failed profile.
      other ? blockService.isBlocked(id, other).catch(() => null) : false,
    ])
    if (!profile) {
      // getProfile reports a failed read as null too: ask strictly (profileExists rejects on failure).
      if (await unifiedProfileService.profileExists(id)) throw new RpcError('The profile could not be read', 'NETWORK')
      if (usernames.length === 0 && !(await identityService.getIdentity(id))) return null
    }
    return toProfileDTO({
      id,
      profile,
      avatar: await avatarOf(id),
      usernames,
      stats,
      ...(viewer ? { viewer: { follows, blocks, isSelf: viewer === id } } : {}),
    })
  },

  /**
   * A profile tab: **posts** (with reposts off v10), **replies** (each with
   * its parent; items are `ProfileReplyDTO`), **top** (the author's proved
   * most-liked posts, one page; `rankings` capability) and **mentions**.
   * The NSFW `hide` preference applies; a blocked author's own posts stay
   * (the profile shows the block).
   */
  async posts(query: ProfilePostsQuery): Promise<Page<PostDTO | ProfileReplyDTO>> {
    switch (query.tab) {
      case 'posts': return postsTab(query.id, query.cursor)
      case 'replies': return repliesTab(query.id, query.cursor)
      case 'mentions': return mentionsTab(query.id, query.cursor)
      case 'top': {
        if (!likesAreIndexOnly()) throw notSupported('The Top tab')
        const ranked = await topLikedPostsHydrated({ postAuthor: query.id, limit: TOP_LIMIT, window: query.window ?? 'all' })
        return onePage(await visibleDTOs(ranked, { dropBlocked: false }))
      }
      default: throw new RpcError(`Unknown profile tab: ${String(query.tab)}`, 'BAD_REQUEST')
    }
  },

  /** User rows for up to 100 identities (`loadIdentityBatch`), in the order given. */
  async batch(ids: string[]): Promise<UserSummaryDTO[]> {
    assertAtMost(ids, 100, 'ids')
    const users = await loadUserSummaries(ids)
    return Array.from(new Set(ids)).flatMap(id => users.get(id) ?? [])
  },

  /**
   * A DiceBear avatar as an SVG string (`lib/services/avatar-generator.ts`), so
   * RN never bundles DiceBear. With `style` and `seed`, that recipe (the
   * style picker's previews); without, the identity's own avatar, or `null`
   * when it is an image (`AvatarDTO.uri`).
   */
  async avatarSvg(identityId: string, style?: string, seed?: string): Promise<string | null> {
    if (style !== undefined && !(DICEBEAR_STYLES as readonly string[]).includes(style)) {
      throw new RpcError(`Unknown avatar style: ${style}`, 'BAD_REQUEST')
    }
    const recipe = style && seed
      ? { style, seed }
      : (await avatarOf(identityId)).dicebear
    return recipe ? generateAvatarSvg(recipe.style, recipe.seed) : null
  },
}
