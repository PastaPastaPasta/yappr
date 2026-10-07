/**
 * How far a feed view's "new posts" checks have read without a gap. Only a
 * complete check moves it forward: a partial one (a failed continuation
 * page, a capped batch) may have missed posts older than the newest it
 * returned, so the next check reads that stretch again, even after the
 * partial result was shown and the newest post on screen moved past it.
 */
export interface NewPostsMark {
  /** The feed view (load generation) the mark belongs to. */
  generation: number
  /** Every post up to this `$createdAt` has been read; the next check starts here. */
  at: number
}

/**
 * Where a check of view `generation` starts: the view's mark once it has
 * one, else the newest post on screen. Never the later of the two: a pill
 * opened after a partial check moves the screen past posts not read yet.
 */
export function newPostsCheckFrom(onScreen: number, mark: NewPostsMark | null, generation: number): number {
  return mark?.generation === generation ? mark.at : onScreen
}

/**
 * The mark after a check that started `from` and returned `posts`: the
 * newest post read when the check was complete, `from` itself when it was
 * partial (set even if the view had no mark yet).
 */
export function markAfterCheck(
  generation: number,
  from: number,
  result: { posts: readonly Record<string, unknown>[]; complete: boolean }
): NewPostsMark {
  if (!result.complete) return { generation, at: from }
  const newest = result.posts.reduce((max, doc) => Math.max(max, Number(doc.$createdAt ?? 0)), from)
  return { generation, at: newest }
}
