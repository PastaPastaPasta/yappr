import type { Post, User } from '@/lib/types'
import type { TargetKind } from '@/lib/contract-topology'
import { DEFAULT_AVATAR_STYLE, DICEBEAR_STYLES } from '@/lib/services/unified-profile-service'
import { isImageAvatar } from '@/lib/profile/v10-profile'
import { isBareRepost } from '@/lib/feed/quote-reposts'
import { findPollrPollLink, getEmbeddedPollId } from '@/lib/poll-embed'

/**
 * Plain data the engine returns to the host. The RN side renders these and
 * nothing else, so they carry only what screens need and no wasm objects,
 * class instances or `lib` internals (`_enrichment`, raw ciphertext).
 * `src/dto/validate.ts` checks every shape at runtime in the tests.
 */

export interface Page<T> {
  items: T[]
  /** Opaque; pass back to fetch the next page. `null` when there is none. */
  cursor: string | null
  hasMore: boolean
}

/** `'today'` is the axis's recent window (rolling on v10), `'all'` all-time. */
export type RankingWindow = 'today' | 'all'

/**
 * Exactly one of the two is set. RN never bundles DiceBear: it renders a
 * generated avatar from `profiles.avatarSvg(id, style, seed)`, cached under
 * `style:seed`.
 */
export interface AvatarDTO {
  /** An image as stored: http(s), or ipfs:// (expand with `engine.info().ipfsGateways`). */
  uri: string | null
  dicebear: { style: string; seed: string } | null
}

export interface AuthorDTO {
  id: string
  /** DPNS name without `.dash`; `null` when the identity has none or it did not resolve. */
  username: string | null
  /** Never empty: the profile name, else the DPNS label, else `User <last 6 of id>`. */
  displayName: string
  avatar: AvatarDTO
  /**
   * The author lookup completed. False when enrichment failed (lib swallows
   * the error), so the fallbacks above are placeholders, not facts; the host
   * may show them and re-fetch.
   */
  resolved: boolean
}

/** A user row (search, engagements, followers, leaderboards). */
export interface UserSummaryDTO extends AuthorDTO {
  bio?: string
  followers?: number
  following?: number
  /** Signed in: the viewer follows this user. */
  viewerFollows?: boolean
}

export interface MediaDTO {
  type: 'image' | 'video' | 'gif'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
}

export interface PostStatsDTO {
  likes: number
  reposts: number
  replies: number
  quotes: number
}

/** The signed-in viewer's marks and relation to the author; absent when signed out. */
export interface ViewerStateDTO {
  liked: boolean
  reposted: boolean
  bookmarked: boolean
  /** v10: the viewer's own quote or bare repost of this target (the one slot), for undo. */
  ownQuoteId: string | null
  /**
   * v10: `ownQuoteId` is a bare repost (no text, media or embed of its own;
   * web's `ownQuote.bare`), undone with "Undo repost". False for a quote with
   * text, which is deleted as a post ("Delete your quote"), and when there is none.
   */
  ownQuoteBare: boolean
  /** The viewer blocked the author (web hides or collapses the card). */
  authorBlocked: boolean
  followsAuthor: boolean
}

export interface PostDTO {
  id: string
  kind: TargetKind
  author: AuthorDTO
  content: string
  createdAt: Date
  stats: PostStatsDTO
  viewer?: ViewerStateDTO
  media: MediaDTO[]
  sensitive: boolean
  /** A v9 tombstone, or (threads) the stand-in for a reply proved deleted. */
  deleted: boolean
  /** Private-feed post: the content is ciphertext, render the "Private post" placeholder. */
  encrypted: boolean
  /** Replies: the post or reply this answers. */
  parentId?: string
  rootPostId?: string
  quotedPostId?: string
  /** The quoted post when it was resolved; absent when not quoted or not loaded. */
  quoted?: PostDTO
  /** The quoted post was proved removed; render the removed stub. */
  quotedRemoved: boolean
  /** v10: a bare repost (no text of its own); render it as `quoted`, attributed to `author`. */
  bareRepost: boolean
  /** Who reposted it (username without `.dash`); `others`: further reposters collapsed into this card (v10). */
  repostedBy?: { id: string; username?: string; displayName?: string; others?: number }
  repostTimestamp?: Date
  /** A cross-contract embed, as stored. */
  embed?: { contractId: string; documentType: string; id: string }
  /**
   * The Pollr poll this post shows (read it with `posts.poll`): a native embed
   * on the configured Pollr contract, or a legacy link in the text, which
   * web hides from the displayed text (`linkUrl`).
   */
  poll?: { id: string; linkUrl?: string }
}

/** One row of a thread's replies, flattened to the one indent level mobile renders. */
export interface ThreadReplyDTO extends PostDTO {
  /** 0: answers the focus; 1: nested below a depth-0 reply (deeper levels flatten here, as on web). */
  depth: 0 | 1
  /** The focus author's own continuation, listed first. */
  isAuthorThread: boolean
  /** Known descendants past the rendered depth ("Continue thread"). */
  hiddenReplyCount: number
  /**
   * A stand-in for a reply proved deleted (v10), holding its children's
   * place: render the "deleted" stub. Its author is blank (`id: ''`, no
   * avatar) and its content empty.
   */
  deletedStub?: true
}

export interface ThreadDTO {
  /** `null` when nothing exists under the id. A v10 bare repost resolves to its target. */
  focus: PostDTO | null
  /** Root first. On flat threads (v9/v10) just the root; on v2 the walked parent chain. */
  ancestors: PostDTO[]
  /** Ancestors proved removed (moderator takedown, v10 author delete): render removed stubs. */
  removedAncestorIds: string[]
  /**
   * Cumulative: each page holds the whole thread loaded so far, re-nested,
   * because a later page can nest under an earlier one. Render the last page.
   */
  replies: Page<ThreadReplyDTO>
}

/** A profile Replies-tab row: the reply with the post or reply it answers. */
export interface ProfileReplyDTO extends PostDTO {
  parent?: PostDTO
  /** The parent was proved deleted or removed (v10). */
  parentRemoved: boolean
}

export interface EngagementDTO {
  user: UserSummaryDTO
  /** Quotes (and v10 bare reposts): the quoting post. */
  quote?: { id: string; content: string }
}

/** `engage.stats`: fresh counts and, signed in, the viewer's marks. */
export interface EngageStatsDTO {
  stats: PostStatsDTO
  viewer?: Pick<ViewerStateDTO, 'liked' | 'reposted' | 'bookmarked' | 'ownQuoteId' | 'ownQuoteBare'>
}

/**
 * What the active contract topology can serve, from lib's predicates, so RN
 * never evaluates `lib/contract-topology.ts` (ADR-001 E2, O9). A read the
 * topology cannot serve rejects with `NOT_SUPPORTED`.
 */
export interface CapabilitiesDTO {
  /** Proved like rankings: the Top sorts, Explore Top, profile Top (`likesAreIndexOnly`). */
  rankings: boolean
  /** The `today` ranking window (`windowedRankingsAvailable`). */
  windowedRankings: boolean
  /** Explore's creator leaderboard and like-ranked trending (`prefixRankingsAvailable`). */
  prefixRankings: boolean
  /** The most-followed leaderboard (`followRankingsAvailable`). */
  followRankings: boolean
  /**
   * v10 quote-slot rules: a repost is a bare quote post, one quote OR repost
   * per author and target, undone by deleting it (`repostsAreQuotes`).
   */
  repostsAreQuotes: boolean
  /** Which kinds can be reposted and bookmarked (`canRepost`, `canBookmark`). */
  repostable: { post: boolean; reply: boolean }
  bookmarkable: { post: boolean; reply: boolean }
  /** Replies name their thread root, so threads page (`hasFlatThreads`). */
  flatThreads: boolean
  /** Deletes leave a tombstone (v9) rather than removing the document (`deletesAreTombstones`). */
  deletesAreTombstones: boolean
  reports: boolean
  reportsResolved: boolean
  /** The highest report reason code the contract accepts: 8, or 9 (sexual content involving minors) on v13. */
  reportReasonMax: number
  /** v13: profiles can be reported too (web only for now; the engine reports posts and replies). */
  profileReports: boolean
  /** The moderators' action fee a report pays, in credits (v13: 50M), or null where reports are free. */
  reportFeeCredits: number | null
  /** The most media items a post or reply carries: 1, or 4 on v13 (publish still attaches one). */
  mediaItems: number
  hashtagsInline: boolean
  /** Posts carry a language and For You filters by it (`postsHaveLanguage`). */
  postLanguage: boolean
  /** `post.content`: code points, and UTF-8 bytes where declared (v10). */
  contentLimits: { chars: number; bytes: number | null }
  profileLimits: { displayName: number; bio: number }
  /** v10: the DashPay profile plus the `yapprProfile` extension. */
  dashpayProfile: boolean
  yappLocked: boolean
  /** Messages: DM v5 (1:1 and groups, no read receipts) or legacy 1:1 with read receipts (`dmIsV5`). */
  dm: 'v5' | 'legacy'
}

export interface EngagementCountsDTO {
  likes: number
  reposts: number
  quotes: number
  /** v10: reposts and quotes come from a 100-document list that filled up; show them as "100+". */
  truncated: boolean
}

export interface EngagementPage extends Page<EngagementDTO> {
  /** v10: the quote list filled its 100-document read; the list stops there. */
  truncated: boolean
}

export interface PollDTO {
  id: string
  ownerId: string
  question: string
  options: { text: string; votes: number }[]
  multiChoice: boolean
  endsAt: Date | null
  createdAt: Date
  /** `null` when the tally could not be read (never shown as "no votes"). */
  totalVotes: number | null
  /** The tally may include ballots cast after the close (v3 polls); not final. */
  tallyIncludesLate: boolean
  /** Signed in: the option indexes the viewer chose; `null` when unreadable (keep the ballot closed). */
  myVotes?: number[] | null
}

export interface TagDTO {
  /** Storage form: lowercase, no `#`/`$`; a cashtag ends in `_cashtag`. */
  tag: string
  kind: 'hashtag' | 'cashtag'
  /** `#tag` or `$TICKER`. */
  display: string
  count: number
  /** v9/v10 trending ranks tags by likes on tagged posts; v2 counts posts. */
  countKind: 'posts' | 'likes'
}

export interface RankedUserDTO {
  user: UserSummaryDTO
  count: number
  by: 'likes' | 'followers'
}

export interface ProfileStatsDTO {
  posts: number
  followers: number
  following: number
}

/** Where a block comes from: the viewer's own block document, or only a block list they follow. */
export type BlockSourceDTO = 'self' | 'list'

export interface ProfileDTO {
  id: string
  /** Primary DPNS name (contested first, then shortest), without `.dash`. */
  username: string | null
  /** Every DPNS name, primary first. */
  usernames: string[]
  displayName: string
  avatar: AvatarDTO
  /**
   * A profile document was read. False means the identity has none (profiles
   * are optional since #605): a read that fails, or an existing document that
   * would not load, rejects instead.
   */
  hasProfile: boolean
  bio?: string
  location?: string
  website?: string
  pronouns?: string
  bannerUrl?: string
  nsfw?: boolean
  joinedAt?: Date
  socialLinks?: { platform: string; handle: string }[]
  /** Display only in 1.0 (tips are deferred). */
  paymentUris?: { scheme: string; uri: string; label?: string }[]
  stats: ProfileStatsDTO
  /**
   * Signed in only. `blocks`: the viewer sees this user as blocked, by their
   * own block or by a block list they follow; `null` when the block lists
   * could not be read. `blockedBy` says where the block comes from: `'self'`
   * (the viewer's own block, which an unblock deletes; it wins when both
   * apply), `'list'` (only a followed block list: an unblock cannot lift it,
   * see `safety.unblock`'s `STILL_BLOCKED`), `null` when not blocked or
   * unreadable.
   */
  viewer?: { follows: boolean; blocks: boolean | null; blockedBy: BlockSourceDTO | null; isSelf: boolean }
}

export interface PostMappingOptions {
  signedIn: boolean
  /** Each identity's avatar (`avatarsOf`); identities missing here fall back to their lib avatar URL. */
  avatars: ReadonlyMap<string, AvatarDTO>
}

const stripDash = (name: string) => name.replace(/\.dash$/i, '')

/** The DPNS label (no `.dash`) and the name shown: the profile name, else the label, else `User <last 6 of id>`. */
function nameOf(id: string, displayName: string | undefined, rawUsername: string | null | undefined) {
  const username = rawUsername ? stripDash(rawUsername) : null
  return { username, displayName: displayName || username || `User ${id.slice(-6)}` }
}

/**
 * A stored avatar field as lib's `parseAvatarField` reads it: an image URI,
 * a DiceBear `{style, seed}` recipe (unknown styles fall back to the
 * default), any other text as a seed, and nothing as the identity's default.
 */
export function avatarFromField(field: string | undefined, identityId: string): AvatarDTO {
  if (field && isImageAvatar(field)) return { uri: field, dicebear: null }
  let dicebear = { style: DEFAULT_AVATAR_STYLE as string, seed: field || identityId }
  if (field) {
    try {
      const parsed = JSON.parse(field) as { style?: unknown; seed?: unknown }
      if (typeof parsed.style === 'string' && typeof parsed.seed === 'string' && parsed.seed) {
        const known = (DICEBEAR_STYLES as readonly string[]).includes(parsed.style)
        dicebear = { style: known ? parsed.style : DEFAULT_AVATAR_STYLE, seed: parsed.seed }
      }
    } catch {
      // Not JSON: the field is a seed.
    }
  }
  return { uri: null, dicebear }
}

function authorAvatar(user: User, avatars: ReadonlyMap<string, AvatarDTO>): AvatarDTO {
  const known = avatars.get(user.id)
  if (known) return known
  // lib's resolved avatar: an image URL survives; a generated one is a data URI RN cannot use.
  return user.avatar && isImageAvatar(user.avatar) ? { uri: user.avatar, dicebear: null } : avatarFromField(undefined, user.id)
}

/**
 * lib's `createDefaultUser` name (sdk-helpers.ts). An author keeps it when a
 * batch author lookup fails (resolvePostAuthorsBatch swallows errors; quoted
 * posts get their authors that way), and also when the lookup finds a DPNS
 * name but no profile (a reposted post on a Posts tab). It is never a name to
 * show: as on web (`hasRealProfile`), the username stands in.
 */
const PLACEHOLDER_NAME = 'Unknown User'

/** The placeholder with no name found at all: a failed lookup. */
const isPlaceholderAuthor = (user: User) => !user.username && user.hasDpns === false && user.displayName === PLACEHOLDER_NAME

function toAuthorDTO(user: User, avatars: ReadonlyMap<string, AvatarDTO>): AuthorDTO {
  const placeholder = isPlaceholderAuthor(user)
  return {
    id: user.id,
    ...nameOf(user.id, user.displayName === PLACEHOLDER_NAME ? '' : user.displayName, user.username),
    avatar: authorAvatar(user, avatars),
    // A successful lookup sets hasDpns; a failed one leaves it undefined (feeds) or the placeholder (batch resolvers).
    resolved: user.hasDpns !== undefined && !placeholder,
  }
}

/** The user rows search, engagements and the graph lists show, from lib's batch identity reads. */
export function toUserSummaryDTO(input: {
  id: string
  username: string | null | undefined
  profile?: { displayName?: string; bio?: string; avatar?: string } | null
  followers?: number
  following?: number
  viewerFollows?: boolean
}): UserSummaryDTO {
  const { id, profile } = input
  return omitUndefined<UserSummaryDTO>({
    id,
    ...nameOf(id, profile?.displayName, input.username),
    avatar: avatarFromField(profile?.avatar, id),
    resolved: true,
    bio: profile?.bio || undefined,
    followers: input.followers,
    following: input.following,
    viewerFollows: input.viewerFollows,
  })
}

/** `components/post/post-card.tsx`: a native poll embed, else a legacy Pollr link in the text. */
function pollOf(post: Post): PostDTO['poll'] {
  const native = getEmbeddedPollId(post)
  if (native) return { id: native }
  const link = findPollrPollLink(post.content)
  return link ? { id: link.pollId, linkUrl: link.url } : undefined
}

export function toPostDTO(post: Post, options: PostMappingOptions): PostDTO {
  return omitUndefined<PostDTO>({
    id: post.id,
    kind: post.targetKind ?? 'post',
    author: toAuthorDTO(post.author, options.avatars),
    content: post.content,
    createdAt: post.createdAt,
    stats: { likes: post.likes, reposts: post.reposts, replies: post.replies, quotes: post.quotes },
    viewer: options.signedIn
      ? {
          liked: post.liked === true,
          reposted: post.reposted === true,
          bookmarked: post.bookmarked === true,
          ownQuoteId: post.ownQuote?.id ?? null,
          ownQuoteBare: post.ownQuote?.bare === true,
          authorBlocked: post._enrichment?.authorIsBlocked === true,
          followsAuthor: post._enrichment?.authorIsFollowing === true,
        }
      : undefined,
    media: (post.media ?? []).map(({ type, url, thumbnail, alt, width, height }) =>
      omitUndefined({ type, url, thumbnail, alt, width, height })),
    sensitive: post.sensitive === true,
    deleted: post.deleted === true,
    encrypted: post.encryptedContent !== undefined,
    parentId: post.parentId || undefined,
    rootPostId: post.rootPostId || undefined,
    quotedPostId: (post.quotedPostId ?? post.quotedReplyId) || undefined,
    quoted: post.quotedPost ? toPostDTO(post.quotedPost, options) : undefined,
    quotedRemoved: post.quotedPostRemoved === true,
    bareRepost: isBareRepost(post),
    repostedBy: post.repostedBy
      ? omitUndefined({
          id: post.repostedBy.id,
          username: post.repostedBy.username ? stripDash(post.repostedBy.username) : undefined,
          displayName: post.repostedBy.displayName || undefined,
          others: post.repostedByOthers || undefined,
        })
      : undefined,
    repostTimestamp: post.repostTimestamp,
    embed: post.embedContractId && post.embedDocType && post.embedId
      ? { contractId: post.embedContractId, documentType: post.embedDocType, id: post.embedId }
      : undefined,
    poll: post.deleted || post.encryptedContent ? undefined : pollOf(post),
  })
}

export function toProfileDTO(input: {
  id: string
  profile: User | null
  /** The stored avatar field (`avatarsOf`); lib's `User.avatar` is already rendered. */
  avatar: AvatarDTO
  usernames: string[]
  stats: ProfileStatsDTO
  viewer?: ProfileDTO['viewer']
}): ProfileDTO {
  const { id, profile, stats } = input
  return omitUndefined<ProfileDTO>({
    id,
    // Without a profile the DPNS label is the name (web's /user does the same since #605).
    ...nameOf(id, profile?.displayName, input.usernames[0]),
    usernames: input.usernames.map(stripDash),
    avatar: input.avatar,
    hasProfile: profile !== null,
    stats,
    viewer: input.viewer,
    bio: profile?.bio || undefined,
    location: profile?.location || undefined,
    website: profile?.website || undefined,
    pronouns: profile?.pronouns || undefined,
    bannerUrl: profile?.bannerUri || undefined,
    nsfw: profile?.nsfw,
    joinedAt: profile?.joinedAt,
    socialLinks: profile?.socialLinks?.length ? profile.socialLinks.map(({ platform, handle }) => ({ platform, handle })) : undefined,
    paymentUris: profile?.paymentUris?.length
      ? profile.paymentUris.map(({ scheme, uri, label }) => omitUndefined({ scheme, uri, label: label || undefined }))
      : undefined,
  })
}

/** Drop keys whose value is undefined, so optional DTO fields are absent rather than present-and-undefined. */
function omitUndefined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
