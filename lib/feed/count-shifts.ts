/**
 * Changes this tab made to a count, per post, shared by every card showing
 * the post (Latest and Top each mount one). A card shows the count its
 * snapshot read plus the confirmed changes made since that snapshot, plus
 * any change still pending. A pending change is never folded into a
 * snapshot's base: a card mounted mid-write keeps the right count whether
 * the write lands or is refused.
 */
export function createCountShifts() {
  const confirmed = new Map<string, number>()
  const pending = new Map<string, number>()
  const listeners = new Set<() => void>()
  const add = (counts: Map<string, number>, postId: string, by: number) => {
    counts.set(postId, (counts.get(postId) ?? 0) + by)
    listeners.forEach((listener) => listener())
  }
  return {
    confirmed: (postId: string) => confirmed.get(postId) ?? 0,
    pending: (postId: string) => pending.get(postId) ?? 0,
    /** A change already on the chain. */
    apply(postId: string, by: number) {
      add(confirmed, postId, by)
    },
    /** A change shown now and settled later: `keep` once it lands, `drop` if it is refused (the first call wins). */
    start(postId: string, by: number) {
      add(pending, postId, by)
      let settled = false
      const settle = (landed: boolean) => {
        if (settled) return
        settled = true
        add(pending, postId, -by)
        if (landed) add(confirmed, postId, by)
      }
      return { keep: () => settle(true), drop: () => settle(false) }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** A snapshot's count, taken when the post's confirmed shift stood at `shift`. */
export interface CountBase {
  count: number
  shift: number
}

/** The count to show: the snapshot's plus the confirmed changes since it and those pending. */
export function shiftedCount(base: CountBase, confirmed: number, pending: number): number {
  return Math.max(0, base.count + confirmed - base.shift + pending)
}
