import { TtlMap } from '@/lib/caches/ttl-map'

/**
 * How long a retry boundary is held after the last incomplete scan, at most.
 * It bounds the case where the app never acknowledges a recovered post (one
 * that lands outside the first `knownIds` after a full-answer reload).
 */
const RETRY_HOLD_MS = 10 * 60_000

/**
 * The Following new-posts check after an incomplete scan (a failed
 * continuation page, a capped owner batch), which may have missed posts
 * older than the newest it returned. The app polls from the newest post it
 * holds, so once it shows that answer its `since` moves past the missed
 * stretch. Per viewer, this keeps the incomplete scan's start, and checks
 * read from there until one is complete and every post recovered from that
 * stretch is acknowledged. A post is acknowledged when it appears in the
 * app's `knownIds`, which means the app inserted it. Web keeps the same rule
 * in `lib/feed/new-posts-mark.ts`.
 */
export class NewPostsRetry {
  private readonly starts = new TtlMap<string, number>(RETRY_HOLD_MS)

  /** Where a check for `key` reads from: `sinceMs`, or a held incomplete scan's earlier start. */
  scanFrom(key: string, sinceMs: number): number {
    const from = this.starts.get(key)
    return from === undefined ? sinceMs : Math.min(from, sinceMs)
  }

  /**
   * After a check from `from` whose answer was built: an incomplete one holds
   * (or keeps) the start. A complete one releases it once it handed back no
   * recovered post, because those are all in `knownIds` now. Until then it
   * keeps the start, so a recovered post left behind an unopened pill is
   * offered again.
   */
  settle(key: string, from: number, complete: boolean, recovered: number): void {
    if (!complete) {
      this.starts.set(key, Math.min(this.starts.get(key) ?? from, from))
    } else if (recovered === 0) {
      this.starts.delete(key)
    }
  }
}

/**
 * The posts a check offers, from a scan of everything after its start:
 * none the app already holds (`known`). Newer than `since` always. In the
 * overlap before it, only when the app sent `known` (as before). Older than
 * the overlap is the re-read stretch of a held retry: those are offered
 * until acknowledged. `recovered` counts the offered ones from that stretch.
 */
export function selectNewPosts<T extends { id: string }>(
  posts: readonly T[],
  timeOf: (post: T) => number,
  window: { since: number; overlapFrom: number; known: ReadonlySet<string> | null }
): { offered: T[]; recovered: number } {
  const offered = posts.filter((post) => {
    if (window.known?.has(post.id)) return false
    const at = timeOf(post)
    return at > window.since || (window.known !== null && at > window.overlapFrom) || at <= window.overlapFrom
  })
  return { offered, recovered: offered.filter((post) => timeOf(post) <= window.overlapFrom).length }
}
