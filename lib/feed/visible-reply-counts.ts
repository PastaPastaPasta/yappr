/**
 * Reply counts as the viewer can see them.
 *
 * A post's reply count is a proved count of its `reply` documents, and an
 * author's delete leaves a tombstone that the count keeps (v11+, until the
 * thread index is keyed on `live`: `replyThreadsCarryLiveMarker`, where the
 * proved count is already right and nothing is recorded). The thread hides a tombstone with
 * nothing live under it, so "1 reply" could sit over an empty thread. Once a
 * post's whole thread has loaded, the detail page records how many replies it
 * actually shows; every card for that post then shows that number while the
 * proved count is still the one it was taken against.
 */

interface ReplyNode {
  content: { deleted?: boolean; deletedStub?: boolean }
  nestedReplies: ReplyNode[]
}

const seen = new Map<string, { counted: number; visible: number }>()

/** Replies a loaded thread shows as readable replies: tombstones and deleted-parent stubs are not replies. */
export function countVisibleReplies(threads: readonly ReplyNode[]): number {
  let total = 0
  for (const thread of threads) {
    if (!thread.content.deleted && !thread.content.deletedStub) total++
    total += countVisibleReplies(thread.nestedReplies)
  }
  return total
}

/**
 * Record what a fully loaded thread shows against the proved count it was read
 * with. Only ever lowers a count: a higher visible number means the counts
 * measure something else (a reply's count is its direct replies) or an index
 * has not caught up, and the proved count already covers that.
 */
export function recordVisibleReplies(postId: string, counted: number, visible: number): void {
  if (visible < counted) seen.set(postId, { counted, visible })
  else seen.delete(postId)
}

/** The count to show for `postId` when the proved count is `counted`. */
export function shownReplyCount(postId: string, counted: number): number {
  const recorded = seen.get(postId)
  return recorded && recorded.counted === counted ? recorded.visible : counted
}

/** Test hook: forget every recorded thread. */
export function resetVisibleReplyCounts(): void {
  seen.clear()
}
