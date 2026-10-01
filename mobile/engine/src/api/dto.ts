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
  /** DPNS name without `.dash`; `null` when the identity has none (or it did not resolve). */
  username: string | null
  displayName: string
  avatarUrl: string
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

/** The signed-in viewer's marks; absent when signed out. */
export interface ViewerStateDTO {
  liked: boolean
  reposted: boolean
  bookmarked: boolean
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
  /** False when the identity has no profile document (it is optional since #605). */
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

const stripDash = (name: string) => name.replace(/\.dash$/i, '')

export function toAuthorDTO(user: User): AuthorDTO {
  return {
    id: user.id,
    username: user.username ? stripDash(user.username) : null,
    displayName: user.displayName,
    avatarUrl: user.avatar,
  }
}

export function toPostDTO(post: Post, signedIn: boolean): PostDTO {
  const dto: PostDTO = {
    id: post.id,
    kind: post.targetKind ?? 'post',
    author: toAuthorDTO(post.author),
    content: post.content,
    createdAt: post.createdAt,
    stats: { likes: post.likes, reposts: post.reposts, replies: post.replies, quotes: post.quotes },
    media: (post.media ?? []).map(({ type, url, thumbnail, alt, width, height }) =>
      omitUndefined({ type, url, thumbnail, alt, width, height })),
    sensitive: post.sensitive === true,
    deleted: post.deleted === true,
    encrypted: post.encryptedContent !== undefined,
    quotedRemoved: post.quotedPostRemoved === true,
  }
  if (signedIn) {
    dto.viewer = { liked: post.liked === true, reposted: post.reposted === true, bookmarked: post.bookmarked === true }
  }
  if (post.parentId) dto.parentId = post.parentId
  if (post.rootPostId) dto.rootPostId = post.rootPostId
  const quotedId = post.quotedPostId ?? post.quotedReplyId
  if (quotedId) dto.quotedPostId = quotedId
  if (post.quotedPost) dto.quoted = toPostDTO(post.quotedPost, signedIn)
  if (post.repostedBy) dto.repostedBy = omitUndefined({ ...post.repostedBy })
  if (post.repostTimestamp) dto.repostTimestamp = post.repostTimestamp
  if (post.embedContractId && post.embedDocType && post.embedId) {
    dto.embed = { contractId: post.embedContractId, documentType: post.embedDocType, id: post.embedId }
  }
  return dto
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
  const base: ProfileDTO = {
    id,
    username,
    usernames,
    // Without a profile the DPNS label is the name (web's /user does the same since #605).
    displayName: profile?.displayName || username || `User ${id.slice(-6)}`,
    avatarUrl: profile?.avatar || input.defaultAvatarUrl,
    hasProfile: profile !== null,
    stats,
  }
  if (!profile) return base
  return omitUndefined({
    ...base,
    bio: profile.bio || undefined,
    location: profile.location || undefined,
    website: profile.website || undefined,
    pronouns: profile.pronouns || undefined,
    bannerUrl: profile.bannerUri || undefined,
    nsfw: profile.nsfw,
    joinedAt: profile.joinedAt,
    socialLinks: profile.socialLinks?.length ? profile.socialLinks.map(({ platform, handle }) => ({ platform, handle })) : undefined,
  })
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
