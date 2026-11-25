/**
 * Changes this tab made to a count, per post, shared by every card showing
 * the post (Latest and Top each mount one). A card shows the count its
 * snapshot read plus the shifts made since that snapshot, so a write on one
 * card shows on the others, and a snapshot that already counts a write is
 * not shifted by it again.
 */
export function createCountShifts() {
  const shifts = new Map<string, number>()
  const listeners = new Set<() => void>()
  const get = (postId: string) => shifts.get(postId) ?? 0
  return {
    get,
    shift(postId: string, by: number) {
      shifts.set(postId, get(postId) + by)
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** A snapshot's count, taken when the post's shift stood at `shift`. */
export interface CountBase {
  count: number
  shift: number
}

/** The count to show: the snapshot's plus the shifts made since it. */
export function shiftedCount(base: CountBase, shift: number): number {
  return Math.max(0, base.count + shift - base.shift)
}
