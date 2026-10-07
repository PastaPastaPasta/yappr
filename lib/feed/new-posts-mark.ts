/**
 * How far a feed view's "new posts" checks have read without a gap. Only a
 * complete check moves it: a partial one (a failed continuation page) may
 * have missed posts older than the newest it returned, so the next check
 * reads that stretch again.
 */
export interface NewPostsMark {
  /** The feed view (load generation) the mark belongs to. */
  generation: number
  /** Every post up to this `$createdAt` has been read. */
  at: number
}

/** Where a check of view `generation` starts: the newest post on screen, or the view's mark if later. */
export function newPostsCheckFrom(onScreen: number, mark: NewPostsMark | null, generation: number): number {
  return Math.max(onScreen, mark?.generation === generation ? mark.at : 0)
}

/** The mark after a check that started `from` and returned `posts`; unchanged when it was partial. */
export function markAfterCheck(
  mark: NewPostsMark | null,
  generation: number,
  from: number,
  result: { posts: readonly Record<string, unknown>[]; complete: boolean }
): NewPostsMark | null {
  if (!result.complete) return mark
  const newest = result.posts.reduce((max, doc) => Math.max(max, Number(doc.$createdAt ?? 0)), from)
  return { generation, at: newest }
}
