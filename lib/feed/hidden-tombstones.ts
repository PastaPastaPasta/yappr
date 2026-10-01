/**
 * v11 tombstones in lists (see `tombstonesAreHidden()`). An author's delete
 * leaves the document in place, `deleted` and blank, so every query that
 * listed the post keeps listing it; these keep it out of what is shown.
 *
 * Pure: they classify documents that are already loaded. Elsewhere (v2, v9,
 * v10) nothing is hidden: v9 renders a tombstone as a deleted card in place,
 * and v2 and v10 have none.
 */

import { tombstonesAreHidden } from '@/lib/contract-topology'

/** True for a post or reply its author tombstoned, on a topology that hides them. */
export function isHiddenTombstone(post: { deleted?: boolean }): boolean {
  return post.deleted === true && tombstonesAreHidden()
}

/** `posts` without the ones {@link isHiddenTombstone} hides, in order. */
export function withoutHiddenTombstones<T extends { deleted?: boolean }>(posts: readonly T[]): T[] {
  return posts.filter((post) => !isHiddenTombstone(post))
}

/**
 * A flat thread's replies without the hidden tombstones nothing live nests
 * under. A tombstoned reply with a live reply anywhere beneath it stays (it
 * renders as a "deleted by its author" stub, so the replies keep their place);
 * a tombstone, or a chain of them, with nothing live beneath goes.
 *
 * The thread is re-assembled from every loaded reply on each page, so a
 * tombstone dropped on one page comes back when a later page brings a live
 * reply under it. It then sits where it always belonged: among its siblings
 * by its own time, directly above that reply. That is no jump: v11's
 * `repliesOf` pages are grouped by parent, so any later page can add replies
 * anywhere in the tree, and a revived tombstone is placed exactly as one of
 * them would be.
 */
export function pruneHiddenTombstones<T extends { id: string; deleted?: boolean; deletedStub?: boolean; replyToReplyId?: string }>(replies: readonly T[]): T[] {
  if (!tombstonesAreHidden() || !replies.some((reply) => reply.deleted === true)) return [...replies]
  // A stub standing in for a moderator-removed parent is as dead as a
  // tombstone: it stays only above a live reply, never over tombstones alone.
  const dead = (reply: T) => reply.deleted === true || reply.deletedStub === true
  const parentOf = new Map(replies.map((reply) => [reply.id, reply.replyToReplyId]))
  // Every ancestor of a live reply has a live descendant. Each walk stops at
  // the first ancestor already marked, so every reply is visited once.
  const aboveLive = new Set<string>()
  for (const reply of replies) {
    if (dead(reply)) continue
    for (let id = reply.replyToReplyId; id !== undefined && !aboveLive.has(id); id = parentOf.get(id)) aboveLive.add(id)
  }
  return replies.filter((reply) => !dead(reply) || aboveLive.has(reply.id))
}
