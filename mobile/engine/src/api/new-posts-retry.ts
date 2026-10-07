/**
 * The Following new-posts check after an incomplete scan (a failed
 * continuation page, a capped owner batch): the scan may have missed posts
 * older than the newest it returned. The app polls from the newest post it
 * holds, so once it shows that answer its `since` moves past the missed
 * stretch. Per viewer, this keeps the incomplete scan's start, and later
 * checks read from there until one is complete. Web keeps the same rule in
 * `lib/feed/new-posts-mark.ts`.
 */
export class NewPostsRetry {
  private readonly pending = new Map<string, { from: number; returned: Set<string> }>()

  /** Where a check for `key` reads from: `sinceMs`, or an incomplete scan's earlier start. */
  scanFrom(key: string, sinceMs: number): number {
    const pending = this.pending.get(key)
    return pending ? Math.min(pending.from, sinceMs) : sinceMs
  }

  /**
   * Whether a post from the re-read stretch (at or before the app's `since`)
   * is still owed to `key`: it has not been handed back since the incomplete
   * scan began, so the app has not been offered it.
   */
  owes(key: string, id: string): boolean {
    const pending = this.pending.get(key)
    return pending !== undefined && !pending.returned.has(id)
  }

  /** After a check from `from` that handed back `ids`: an incomplete one keeps the start, a complete one clears it. */
  settle(key: string, from: number, complete: boolean, ids: readonly string[]): void {
    if (complete) {
      this.pending.delete(key)
      return
    }
    const pending = this.pending.get(key) ?? { from, returned: new Set<string>() }
    pending.from = Math.min(pending.from, from)
    for (const id of ids) pending.returned.add(id)
    this.pending.set(key, pending)
  }
}
