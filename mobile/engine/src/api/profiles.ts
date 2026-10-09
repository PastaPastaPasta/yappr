import { cacheManager } from '@/lib/cache-manager'
import { TtlMap } from '@/lib/caches/ttl-map'
import { likesAreIndexOnly, repostsAreQuotes } from '@/lib/contract-topology'
import { fetchReplyParents } from '@/lib/feed/resolve-reply-parents'
import { byNewestActivity, resolveUserReposts } from '@/lib/feed/resolve-user-reposts'
import { logger } from '@/lib/logger'
import { generateAvatarSvg } from '@/lib/services/avatar-generator'
import { avatarStylesReady } from '../avatar-styles'
import { blockService, type BlockProvenance } from '@/lib/services/block-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { followService } from '@/lib/services/follow-service'
import { identityService } from '@/lib/services/identity-service'
import { mentionService, type PostMentionDocument } from '@/lib/services/mention-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { topLikedPostsHydrated } from '@/lib/services/ranked-likes'
import { replyService } from '@/lib/services/reply-service'
import { repostService } from '@/lib/services/repost-service'
import { loadUserStats } from '@/lib/services/social-stats-service'
import { avatarSeedMaxLength, profileSources, profileTextLimits } from '@/lib/profile/v10-profile'
import { settleSupersededReplaces } from '@/lib/services/identity-nonce'
import { DICEBEAR_STYLES, unifiedProfileService, type DiceBearStyle, type UpdateUnifiedProfileData } from '@/lib/services/unified-profile-service'
import { ListLimitError } from '@/lib/typed-array-codecs'
import type { Post } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import {
  assertAtMost, avatarOf, badRequest, isIdentityId, listToDTOs, loadUserSummaries, notSupported, quoteTargetIds, requireViewer, rereadQuotedPosts,
  toPostDTOs, viewerId, visibleDTOs, withLoadingAuthor,
} from '../dto/hydrate'
import { onePage, pageAfter, pageOfList } from '../dto/paging'
import { assertMediaUrl, characters, relationProbe, signer } from '../writes/handler-kit'
import { NotSentError, type TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import {
  toProfileDTO,
  type BlockSourceDTO, type Page, type PostDTO, type ProfileDTO, type ProfileReplyDTO, type RankingWindow, type UserSummaryDTO,
} from './dto'

export type ProfileTab = 'posts' | 'replies' | 'top' | 'mentions'

export interface ProfilePostsQuery {
  id: string
  tab: ProfileTab
  /** Top only; default `all`. */
  window?: RankingWindow
  cursor?: string | null
  /** Top only: a pull to refresh, read afresh past lib's minute-long ranked cache. */
  refresh?: boolean
}

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
      rereadQuotedPosts(quoteTargetIds(posts))
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
      rereadQuotedPosts(quoteTargetIds([...replies, ...parentList]))
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
    // Strict: a failed read must not be cached as nobody mentioning them.
    load: async () => (await mentionService.getPostsMentioningUser(id, { throwOnError: true })).sort((a, b) => b.$createdAt - a.$createdAt),
    hydrate: async (slice) => {
      const { posts, preloaded } = await mentionService.loadMentioningPosts(slice)
      rereadQuotedPosts(quoteTargetIds(posts))
      return listToDTOs(posts.map(withLoadingAuthor), preloaded, { dropBlocked: false })
    },
  })
}

const NOT_BLOCKED: BlockProvenance = { isBlocked: false, isOwnBlock: false, inheritedFrom: null }

/** `ProfileDTO.viewer`'s block fields from lib's provenance (`null`: unreadable). */
function viewerBlock(provenance: BlockProvenance | null): { blocks: boolean | null; blockedBy: BlockSourceDTO | null } {
  if (!provenance) return { blocks: null, blockedBy: null }
  const blockedBy = provenance.isOwnBlock ? 'self' : provenance.isBlocked ? 'list' : null
  return { blocks: provenance.isBlocked, blockedBy }
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
    const id = isIdentityId(input) ? input : await dpnsService.resolveIdentity(input)
    if (!id) return null
    const viewer = viewerId()
    const other = viewer && viewer !== id ? viewer : null
    const [stats, profile, usernames, follows, provenance] = await Promise.all([
      loadUserStats(id),
      unifiedProfileService.getProfile(id),
      dpnsService.getAllUsernamesSorted(id),
      other ? followService.isFollowing(id, other) : false,
      // The block status decorates the header; an unreadable block list is `null`, not a failed profile.
      other ? blockService.getBlockProvenance(id, other).catch(() => null) : NOT_BLOCKED,
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
      ...(viewer ? { viewer: { follows, ...viewerBlock(provenance), isSelf: viewer === id } } : {}),
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
        // A pull to refresh reads past the ranked cache, and a failed read
        // rejects rather than showing no posts, as the home Top view's do.
        const ranked = await topLikedPostsHydrated({
          postAuthor: query.id, limit: TOP_LIMIT, window: query.window ?? 'all', force: query.refresh === true, throwOnError: true,
        })
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
    if (!recipe) return null
    await avatarStylesReady()
    return generateAvatarSvg(recipe.style, recipe.seed)
  },
}

/**
 * A profile edit (`app/user/page.tsx` `handleSaveProfile`, `hooks/use-avatar.ts`):
 * only the fields given change. `''` (or `null` for the avatar and banner)
 * clears a field; a blank display name keeps the stored one. The avatar is
 * an image URL or a DiceBear recipe (`engine.info().avatarStyles`).
 */
export interface ProfilePatchDTO {
  displayName?: string
  bio?: string
  location?: string
  website?: string
  pronouns?: string
  avatar?: { uri: string } | { dicebear: { style: string; seed: string } } | null
  bannerUri?: string | null
  nsfw?: boolean
}

const TEXT_FIELDS = ['displayName', 'bio', 'location', 'website', 'pronouns'] as const
/** Stored as given (trimmed); `''` clears. The display name differs: a blank one keeps the stored name. */
const EXACT_FIELDS = ['bio', 'location', 'website', 'pronouns', 'bannerUri'] as const
const PATCH_FIELDS: readonly string[] = [...TEXT_FIELDS, 'avatar', 'bannerUri', 'nsfw']

/** The patch as `updateProfile` takes it, after the checks web's form makes. `BAD_REQUEST` otherwise. */
function toProfileUpdate(patch: ProfilePatchDTO): UpdateUnifiedProfileData {
  if (typeof patch !== 'object' || patch === null) throw badRequest('patch must be an object')
  const unknown = Object.keys(patch).find(key => !PATCH_FIELDS.includes(key))
  if (unknown) throw badRequest(`Unknown profile field: ${unknown}`)
  const update: UpdateUnifiedProfileData = {}
  for (const field of TEXT_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    if (typeof value !== 'string') throw badRequest(`${field} must be a string`)
    update[field] = value
  }
  const limits = profileTextLimits()
  if (update.displayName && characters(update.displayName.trim()) > limits.displayName) {
    throw badRequest(`Display name must be at most ${limits.displayName} characters`)
  }
  if (update.bio && characters(update.bio.trim()) > limits.bio) throw badRequest(`Bio must be at most ${limits.bio} characters`)
  if (patch.nsfw !== undefined) {
    if (typeof patch.nsfw !== 'boolean') throw badRequest('nsfw must be a boolean')
    update.nsfw = patch.nsfw
  }
  if (patch.bannerUri !== undefined) {
    if (patch.bannerUri !== null) assertMediaUrl(patch.bannerUri, 'bannerUri')
    update.bannerUri = patch.bannerUri ?? ''
  }
  if (patch.avatar !== undefined) {
    if (typeof patch.avatar !== 'object') throw badRequest('avatar must be {uri}, {dicebear} or null')
    update.avatar = avatarField(patch.avatar)
  }
  return update
}

/** An avatar as stored: the image URI, or the recipe `encodeAvatarData` writes (`use-avatar.ts`). */
function avatarField(avatar: NonNullable<ProfilePatchDTO['avatar']> | null): string {
  if (avatar === null) return ''
  if ('uri' in avatar) {
    assertMediaUrl(avatar.uri, 'avatar.uri')
    return avatar.uri
  }
  const { style, seed } = avatar.dicebear ?? {}
  if (typeof style !== 'string' || !(DICEBEAR_STYLES as readonly string[]).includes(style)) throw badRequest(`Unknown avatar style: ${String(style)}`)
  if (typeof seed !== 'string' || !seed || seed.length > avatarSeedMaxLength()) {
    throw badRequest(`The avatar seed must be 1 to ${avatarSeedMaxLength()} characters`)
  }
  return unifiedProfileService.encodeAvatarData(seed, style as DiceBearStyle)
}

/**
 * Whether the stored profile shows the edit, read fresh (lib's profile
 * cache dropped first). lib reports a failed profile read as "none", so a
 * missing profile counts only when `profileExists` (which rejects on
 * failure) agrees.
 */
async function profileShows(ownerId: string, update: UpdateUnifiedProfileData): Promise<boolean> {
  cacheManager.invalidateByTag(`user:${ownerId}`)
  const profile = await unifiedProfileService.getProfile(ownerId)
  if (!profile) {
    if (await unifiedProfileService.profileExists(ownerId)) throw new Error('The profile could not be read')
    return false
  }
  return (!update.displayName?.trim() || profile.displayName === update.displayName.trim()) &&
    EXACT_FIELDS.every(field => {
      const next = update[field]
      return next === undefined || (profile[field] ?? '') === next.trim()
    }) &&
    (update.nsfw === undefined || (profile.nsfw === true) === update.nsfw) &&
    (update.avatar === undefined || ((await unifiedProfileService.getStoredAvatar(ownerId)) ?? '') === update.avatar)
}

/**
 * An earlier profile save of `ownerId` whose answer was lost (its wait timed
 * out) but which has since landed stops holding writes back. lib keeps such
 * an SDK-signed replace pending for 15 minutes (`PENDING_LIFETIME_MS`): until
 * then the next save, and on v10 every write to the social contract that holds
 * `yapprProfile`, fails PENDING_WRITE. `settleSupersededReplaces` releases it
 * only once Platform shows the document at the revision it wrote and its
 * nonce consumed, so a save that has not landed yet still holds them back
 * (as does one this could not read: a failure proves nothing).
 */
function settleLandedProfileSaves(ownerId: string): Promise<number[]> {
  const contracts = [...new Set(profileSources().map(({ source }) => source.contractId))]
  return Promise.all(contracts.map(contractId => settleSupersededReplaces(ownerId, contractId)))
}

/** Whether the stored profile shows the edit (`profileShows`), proved twice for an absence. */
const proveEdit = relationProbe<UpdateUnifiedProfileData>(async ({ viewer, args }) => {
  if (!args) throw new Error('This edit can no longer be checked')
  return profileShows(viewer, args)
}, true)

/**
 * `profiles.update`: the viewer's profile through `updateProfile` (v10: the
 * DashPay `profile`, then `yapprProfile`; v2: one `profile` document, which
 * the first save creates). On v10 an image avatar is fingerprinted from its
 * URL in the engine; where that fails it is stored in the extension only.
 */
export function createProfileWrites(tickets: TicketStore) {
  tickets.register<UpdateUnifiedProfileData>('profile.update', {
    persistArgs: true,
    async run(update, ctx) {
      const owner = signer(ctx)
      await settleLandedProfileSaves(owner)
        .catch(error => logger.debug('Profile: could not settle an earlier save:', error))
      // A document sent whose confirmation wait timed out: the save may still land, or never execute.
      let unconfirmed = false
      try {
        await unifiedProfileService.updateProfile(owner, update, {
          onUnconfirmed: () => { unconfirmed = true },
          // "Saving… (1 of 2)" (UX_SPEC edit.saving): v10 writes the DashPay profile, then yapprProfile.
          onProgress: ({ step, total }) => {
            try {
              ctx.progress(step - 1, total)
            } catch {
              // Progress is cosmetic: it never stops a save between its two documents.
            }
          },
        })
      } catch (error) {
        // The plan's own refusals (lengths, list limits, URL rules) come before anything is signed.
        if (error instanceof ListLimitError) throw new NotSentError(badRequest(error.message))
        throw error
      }
      // updateProfile throws on a failure; a save it could not confirm is checked (`probe`), never reported saved.
      return { state: unconfirmed ? 'unconfirmed' : 'confirmed' }
    },
    async probe(ticket, args, kit) {
      const proved = await proveEdit(ticket, args, kit)
      // A save that landed after its wait timed out stops holding the account's other writes back now,
      // not at its next save. Not awaited: the settle waits for the write lock, which a call still
      // running past its deadline holds.
      if (proved.state === 'applied' && ticket.identityId) {
        settleLandedProfileSaves(ticket.identityId)
          .catch(error => logger.debug('Profile: could not settle a landed save:', error))
      }
      return proved
    },
  })

  return {
    async update(patch: ProfilePatchDTO): Promise<WriteTicket> {
      const update = toProfileUpdate(patch)
      const viewer = requireViewer('Editing a profile')
      return tickets.submit({ op: 'profile.update', args: update, target: { identityId: viewer } })
    },
  }
}
