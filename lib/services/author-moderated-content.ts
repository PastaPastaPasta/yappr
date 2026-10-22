import type { Post } from '@/lib/types'
import { postOwnerIndexPrefix, replyOwnerIndexPrefix, type LanePin } from '@/lib/contract-topology'
import { laneVariants } from '@/lib/moderation-lanes'
import { isHidden } from '@/lib/moderation-view'

/**
 * One account's posts and replies that yap.pr does not list (social v18,
 * docs/SOCIAL_V18.md "Reading the lanes"): every `ownerAndTime` lane but the
 * listed one, `live == 1, mod == null`. Read for the profile's Moderation tab,
 * which only the contract's seated moderators see. No writes.
 */

/** One unlisted lane: written while restricted (`live` 2) and/or hidden (`mod` 1) or held for legal reasons (`mod` 2). */
export interface AuthorLane {
  live: 1 | 2
  mod: 1 | 2 | null
}

/** Documents read per lane and type. A lane that fills it may hold more. */
export const AUTHOR_LANE_LIMIT = 100

/** Every lane of `prefix` (`live == 1, mod == null` on v18) but the listed one, as pins. */
export function unlistedLanePins(prefix: readonly LanePin[]): LanePin[][] {
  return laneVariants(prefix.map((pin) => [...pin] as LanePin)).slice(1)
}

/** The lane a post or reply is filed in, read off its own marks; null for a listed one. */
export function laneOf(post: Pick<Post, 'moderation'>): AuthorLane | null {
  const marks = post.moderation
  const live = marks?.restricted ? 2 : 1
  const mod = isHidden(marks) ? (marks?.mod === 2 ? 2 : 1) : null
  return live === 1 && mod === null ? null : { live, mod }
}

export const laneKey = (lane: AuthorLane) => `${lane.live}:${lane.mod ?? 'null'}`

/** How moderators read a lane's name. */
export function laneLabel(lane: AuthorLane): string {
  const hidden = lane.mod === 2 ? 'Hidden for legal reasons' : lane.mod === 1 ? 'Hidden' : null
  if (lane.live === 1) return hidden ?? 'Listed'
  return hidden ? `Restricted · ${hidden.charAt(0).toLowerCase()}${hidden.slice(1)}` : 'Restricted'
}

export interface LaneCount {
  lane: AuthorLane
  count: number
}

export interface AuthorModeratedContent {
  /** Posts and replies, newest first, once each. */
  items: Post[]
  /** Each lane with anything in it, in a fixed order, with how many of `items` it holds. */
  lanes: LaneCount[]
  /** True when some read filled its page, so the account may have more than `items`. */
  more: boolean
}

const LANE_ORDER: AuthorLane[] = [
  { live: 1, mod: 1 }, { live: 1, mod: 2 }, { live: 2, mod: null }, { live: 2, mod: 1 }, { live: 2, mod: 2 },
]

/** Merges what the lane reads returned: once each (a read may return another lane's too), newest first, counted per lane. */
export function mergeAuthorLanes(pages: readonly { items: readonly Post[]; full: boolean }[]): AuthorModeratedContent {
  const byId = new Map<string, Post>()
  for (const page of pages) for (const post of page.items) if (laneOf(post) && !byId.has(post.id)) byId.set(post.id, post)
  const items = Array.from(byId.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const counts = new Map<string, number>()
  for (const post of items) {
    const lane = laneOf(post)
    if (lane) counts.set(laneKey(lane), (counts.get(laneKey(lane)) ?? 0) + 1)
  }
  return {
    items,
    lanes: LANE_ORDER.flatMap((lane) => (counts.get(laneKey(lane)) ? [{ lane, count: counts.get(laneKey(lane)) ?? 0 }] : [])),
    more: pages.some((page) => page.full),
  }
}

/**
 * `authorId`'s unlisted posts and replies, the newest
 * {@link AUTHOR_LANE_LIMIT} of each lane. Rejects when any read fails: a
 * partial answer would read as a complete one.
 */
export async function readAuthorModeratedContent(authorId: string): Promise<AuthorModeratedContent> {
  const [{ postService, replyToPost }, { replyService }] = await Promise.all([import('./post-service'), import('./reply-service')])
  const owner = (pins: LanePin[]) => [...pins, ['$ownerId', '==', authorId], ['$createdAt', '>', 0]] as NonNullable<Parameters<typeof postService.query>[0]>['where']
  const reads = [
    ...unlistedLanePins(postOwnerIndexPrefix()).map(async (pins) => {
      const { documents } = await postService.getUserPosts(authorId, { where: owner(pins), limit: AUTHOR_LANE_LIMIT })
      return { items: documents, full: documents.length >= AUTHOR_LANE_LIMIT }
    }),
    ...unlistedLanePins(replyOwnerIndexPrefix()).map(async (pins) => {
      const { documents } = await replyService.getUserReplies(authorId, { where: owner(pins), limit: AUTHOR_LANE_LIMIT })
      return { items: documents.map(replyToPost), full: documents.length >= AUTHOR_LANE_LIMIT }
    }),
  ]
  return mergeAuthorLanes(await Promise.all(reads))
}
