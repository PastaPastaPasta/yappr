import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment'
import { repostedAuthorIdOf } from '@/lib/feed/quote-reposts'
import { blockService } from '@/lib/services/block-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { followService } from '@/lib/services/follow-service'
import { loadIdentityBatch } from '@/lib/services/identity-batch'
import { postService } from '@/lib/services/post-service'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { useSettingsStore } from '@/lib/store'
import { getPrimaryUsername } from '@/lib/utils/username'
import type { Post } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import {
  avatarFromField, toPostDTO, toUserSummaryDTO,
  type AvatarDTO, type PostDTO, type UserSummaryDTO,
} from '../api/dto'

/**
 * The steps every read shares on its way from lib's `Post`s to DTOs: the
 * enrichment, the viewer filters web applies to browsing lists, avatars and
 * user rows.
 */

export const viewerId = (): string | null => getCurrentUserId()

export function requireViewer(what: string): string {
  const viewer = viewerId()
  if (!viewer) throw new RpcError(`${what} needs a signed-in account`, 'NOT_SIGNED_IN')
  return viewer
}

/** `BAD_REQUEST` beyond `max` entries (the batch reads' cap, Drive's `in` limit). */
export function assertAtMost(list: readonly unknown[], max: number, what: string): void {
  if (list.length > max) throw new RpcError(`At most ${max} ${what}`, 'BAD_REQUEST')
}

export function notSupported(what: string): RpcError {
  return new RpcError(`${what} is not available on this contract topology`, 'NOT_SUPPORTED')
}

export function badRequest(message: string): RpcError {
  return new RpcError(message, 'BAD_REQUEST')
}

/** Base58 of 32 bytes: 43 or 44 characters. */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

export const isIdentityId = (value: unknown): value is string => typeof value === 'string' && IDENTITY_ID.test(value)

/**
 * Timeline documents arrive with "Unknown User" placeholders (`hasDpns:
 * false`). Reset them to lib's loading shape (`withLoadingAuthor`), so a
 * failed enrichment reads as unresolved rather than as a name.
 */
export function withLoadingAuthor(post: Post): Post {
  return { ...post, author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined } }
}

/**
 * The stored avatar of each identity that has a profile document. The reads
 * hit lib's profile cache, which enrichment has just filled; identities left
 * out fall back to lib's avatar URL in the mapper.
 */
export async function avatarsOf(ids: string[]): Promise<Map<string, AvatarDTO>> {
  const docs = await unifiedProfileService.getProfilesByIdentityIds(Array.from(new Set(ids.filter(Boolean))))
  return new Map(docs.map(doc => [doc.$ownerId, avatarFromField(doc.avatar, doc.$ownerId)]))
}

/** One identity's stored avatar, or its default. */
export async function avatarOf(id: string): Promise<AvatarDTO> {
  return (await avatarsOf([id])).get(id) ?? avatarFromField(undefined, id)
}

/** Map already-enriched posts (and their quoted posts) to DTOs. */
export async function toPostDTOs(posts: Post[]): Promise<PostDTO[]> {
  const ids = posts.flatMap(post => [post.author.id, post.quotedPost?.author.id ?? ''])
  const options = { signedIn: viewerId() !== null, avatars: await avatarsOf(ids) }
  return posts.map(post => toPostDTO(post, options))
}

/** lib's batch enrichment (authors, stats, viewer marks, relations, quoted posts), then DTOs. */
export async function enrichToDTOs(posts: Post[], preloaded?: PreloadedEnrichment): Promise<PostDTO[]> {
  if (posts.length === 0) return []
  return toPostDTOs(await postService.enrichPostsBatch(posts, preloaded))
}

/**
 * Drop posts whose author the viewer blocked, including the author shown
 * behind a v10 bare repost (`use-feed-data.ts` `filteredPosts`). Block
 * lookups fail soft to "not blocked", as on web.
 */
async function dropBlocked(posts: Post[]): Promise<Post[]> {
  const viewer = viewerId()
  if (!viewer || posts.length === 0) return posts
  const ids = Array.from(new Set(posts.flatMap(post => [post.author.id, repostedAuthorIdOf(post) ?? '']).filter(Boolean)))
  const blocked = await blockService.checkBlockedBatch(viewer, ids).catch(() => new Map<string, boolean>())
  return posts.filter(post => !blocked.get(post.author.id) && !blocked.get(repostedAuthorIdOf(post) ?? ''))
}

/**
 * The viewer filters web applies to browsing lists (feeds, tags, explore,
 * profile tabs) on enriched posts: drop blocked authors, then the NSFW `hide`
 * preference (`filterHiddenSensitive`; threads and single posts render the
 * gate instead). Then DTOs.
 */
export async function visibleDTOs(posts: Post[], options: { dropBlocked?: boolean } = {}): Promise<PostDTO[]> {
  // A profile's own tabs keep a blocked author's posts: the page shows the block instead.
  const unblocked = options.dropBlocked === false ? posts : await dropBlocked(posts)
  const visible = filterHiddenSensitive(unblocked, useSettingsStore.getState().sensitiveContentMode, viewerId())
  return toPostDTOs(visible)
}

/** A browsing list from lib documents: batch enrichment, then {@link visibleDTOs}. */
export async function listToDTOs(posts: Post[], preloaded?: PreloadedEnrichment, options?: { dropBlocked?: boolean }): Promise<PostDTO[]> {
  if (posts.length === 0) return []
  return visibleDTOs(await postService.enrichPostsBatch(posts, preloaded), options)
}

/**
 * User rows from lib's batch identity reads (`loadIdentityBatch`: names,
 * profiles), as the engagements and followers pages build them. `counts` adds
 * follower/following counts; signed in, `viewerFollows` is set.
 */
export async function loadUserSummaries(
  ids: string[],
  options: { counts?: boolean; usernames?: ReadonlyMap<string, string | null>; viewerFollows?: boolean } = {},
): Promise<Map<string, UserSummaryDTO>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  // Search, mentions and leaderboards show no follow button on web, so they skip the read.
  const viewer = options.viewerFollows === false ? null : viewerId()
  // With the names known, only the profiles are read (loadIdentityBatch would also render every avatar).
  const identities = options.usernames
    ? unifiedProfileService.getProfilesByIdentityIds(unique).then(profiles => ({ usernames: options.usernames, profiles }))
    : loadIdentityBatch(unique)
  const [{ usernames, profiles }, followerCounts, followingCounts, follows] = await Promise.all([
    identities,
    options.counts ? followService.countFollowersBatch(unique) : undefined,
    options.counts ? followService.countFollowingBatch(unique) : undefined,
    viewer ? followService.getFollowStatusBatch(unique, viewer) : undefined,
  ])
  const profileOf = new Map(profiles.map(profile => [profile.$ownerId, profile]))
  return new Map(unique.map(id => [id, toUserSummaryDTO({
    id,
    username: usernames?.get(id),
    profile: profileOf.get(id),
    followers: followerCounts?.get(id) ?? (options.counts ? 0 : undefined),
    following: followingCounts?.get(id) ?? (options.counts ? 0 : undefined),
    viewerFollows: follows ? follows.get(id) === true : undefined,
  })]))
}

/**
 * Users whose DPNS name starts with `prefix`, one row per identity named by
 * the best of its matching names (`getPrimaryUsername`), as web's search
 * page and mention autocomplete build them. `exactFallback` adds an exact
 * name resolution when the prefix search finds nothing (search page).
 */
export async function searchUserSummaries(prefix: string, limit: number, exactFallback = false): Promise<UserSummaryDTO[]> {
  const results = await dpnsService.searchUsernamesWithDetails(prefix, limit)
  if (results.length === 0 && exactFallback) {
    const ownerId = await dpnsService.resolveIdentity(prefix)
    if (ownerId) results.push({ username: `${prefix.toLowerCase().replace(/\.dash$/, '')}.dash`, ownerId })
  }
  const namesOf = new Map<string, string[]>()
  for (const { username, ownerId } of results) {
    if (ownerId) namesOf.set(ownerId, [...(namesOf.get(ownerId) ?? []), username])
  }
  const usernames = new Map(Array.from(namesOf, ([id, names]) => [id, getPrimaryUsername(names) ?? names[0]]))
  const users = await loadUserSummaries(Array.from(namesOf.keys()), { usernames, viewerFollows: false })
  return Array.from(namesOf.keys()).flatMap(id => users.get(id) ?? [])
}
