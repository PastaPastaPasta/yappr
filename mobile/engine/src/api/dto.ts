import type { Post, User } from '@/lib/types'
import type { TargetKind } from '@/lib/contract-topology'

/**
 * Plain data the engine returns to the host. The RN side renders these and
 * nothing else, so they carry only what screens need and no wasm objects,
 * class instances or `lib` internals (`_enrichment`, raw ciphertext).
 */

export interface Page<T> {
  items: T[]
  /** Opaque; pass back to fetch the next page. `null` when there is none. */
  cursor: string | null
  hasMore: boolean
}

export interface AuthorDTO {
  id: string
  /** DPNS name without `.dash`; `null` when the identity has none or it did not resolve. */
  username: string | null
  /** Never empty: the profile name, else the DPNS label, else `User <last 6 of id>`. */
  displayName: string
  /** Never empty: the profile avatar, else the default DiceBear avatar. */
  avatarUrl: string
  /**
   * The author lookup completed. False when enrichment failed (lib swallows
   * the error), so the fallbacks above are placeholders, not facts; the host
   * may show them and re-fetch.
   */
  resolved: boolean
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
  /** A v9 tombstone: the author deleted it, the document stays. */
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
  repostedBy?: { id: string; username?: string; displayName?: string }
  repostTimestamp?: Date
  /** A cross-contract embed (a Pollr poll). */
  embed?: { contractId: string; documentType: string; id: string }
}

export interface ProfileStatsDTO {
  posts: number
  followers: number
  following: number
}

export interface ProfileDTO {
  id: string
  /** Primary DPNS name (contested first, then shortest), without `.dash`. */
  username: string | null
  /** Every DPNS name, primary first. */
  usernames: string[]
  displayName: string
  avatarUrl: string
  /**
   * A profile document was read. False when the identity has none (profiles
   * are optional since #605) OR when the read failed: lib's getProfile
   * returns null for both. Never treat false alone as "no profile" before an
   * owner edit; re-check strictly first, as web's /user page does.
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
  stats: ProfileStatsDTO
}

export interface PostMappingOptions {
  signedIn: boolean
  /** The DiceBear placeholder for an identity (unifiedProfileService.getDefaultAvatarUrl). */
  defaultAvatarUrl: (identityId: string) => string
}

const stripDash = (name: string) => name.replace(/\.dash$/i, '')
const shortName = (id: string) => `User ${id.slice(-6)}`

export function toAuthorDTO(user: User, defaultAvatarUrl: (identityId: string) => string): AuthorDTO {
  const username = user.username ? stripDash(user.username) : null
  return {
    id: user.id,
    username,
    displayName: user.displayName || username || shortName(user.id),
    avatarUrl: user.avatar || defaultAvatarUrl(user.id),
    // enrichPostsBatch sets hasDpns on success; a failed or skipped lookup leaves it undefined.
    resolved: user.hasDpns !== undefined,
  }
}

export function toPostDTO(post: Post, options: PostMappingOptions): PostDTO {
  return omitUndefined<PostDTO>({
    id: post.id,
    kind: post.targetKind ?? 'post',
    author: toAuthorDTO(post.author, options.defaultAvatarUrl),
    content: post.content,
    createdAt: post.createdAt,
    stats: { likes: post.likes, reposts: post.reposts, replies: post.replies, quotes: post.quotes },
    viewer: options.signedIn
      ? {
          liked: post.liked === true,
          reposted: post.reposted === true,
          bookmarked: post.bookmarked === true,
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
    repostedBy: post.repostedBy ? omitUndefined(post.repostedBy) : undefined,
    repostTimestamp: post.repostTimestamp,
    embed: post.embedContractId && post.embedDocType && post.embedId
      ? { contractId: post.embedContractId, documentType: post.embedDocType, id: post.embedId }
      : undefined,
  })
}

export function toProfileDTO(input: {
  id: string
  profile: User | null
  usernames: string[]
  stats: ProfileStatsDTO
  defaultAvatarUrl: string
}): ProfileDTO {
  const { id, profile, stats } = input
  const usernames = input.usernames.map(stripDash)
  const username = usernames[0] ?? null
  return omitUndefined<ProfileDTO>({
    id,
    username,
    usernames,
    // Without a profile the DPNS label is the name (web's /user does the same since #605).
    displayName: profile?.displayName || username || shortName(id),
    avatarUrl: profile?.avatar || input.defaultAvatarUrl,
    hasProfile: profile !== null,
    stats,
    bio: profile?.bio || undefined,
    location: profile?.location || undefined,
    website: profile?.website || undefined,
    pronouns: profile?.pronouns || undefined,
    bannerUrl: profile?.bannerUri || undefined,
    nsfw: profile?.nsfw,
    joinedAt: profile?.joinedAt,
    socialLinks: profile?.socialLinks?.length ? profile.socialLinks.map(({ platform, handle }) => ({ platform, handle })) : undefined,
  })
}

/** Drop keys whose value is undefined, so optional DTO fields are absent rather than present-and-undefined. */
function omitUndefined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
