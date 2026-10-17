/**
 * Private-feed approval and removal notifications (R-S14), derived on the
 * follower's device by diffing the feeds they can read (the recipient-first
 * grant index, D32) against what this device saw last time.
 *
 * - An owner who appears is an approval.
 * - An owner who disappears is a removal: every grant from them is gone.
 * - A renewal moves a follower to the owner's next feed; the owner stays in
 *   the list, so it notifies nothing.
 *
 * The first look on a device only records the list: nothing old is announced.
 */

export interface HeldGrant {
  ownerId: string
  feed: number
}

export interface AccessDiff {
  /** The owners to remember for the next look. */
  snapshot: string[]
  /** Owners who granted access since the last look, with their newest feed. */
  approved: HeldGrant[]
  /** Owners whose every grant went away since the last look. */
  removed: string[]
}

export function parseAccessSnapshot(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null
  } catch {
    return null
  }
}

export function diffAccess(previous: readonly string[] | null, grants: readonly HeldGrant[]): AccessDiff {
  const newest = new Map<string, number>()
  for (const grant of grants) newest.set(grant.ownerId, Math.max(newest.get(grant.ownerId) ?? 0, grant.feed))
  const snapshot = [...newest.keys()].sort()
  if (previous === null) return { snapshot, approved: [], removed: [] }
  const before = new Set(previous)
  return {
    snapshot,
    approved: snapshot.filter((ownerId) => !before.has(ownerId)).map((ownerId) => ({ ownerId, feed: newest.get(ownerId) as number })),
    removed: previous.filter((ownerId) => !newest.has(ownerId)),
  }
}
