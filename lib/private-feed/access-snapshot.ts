/**
 * Private-feed approval and removal notifications (R-S14), derived on the
 * follower's device by diffing the feeds they can read (the recipient-first
 * grant index, D32) against what this device saw last time.
 *
 * Each owner is remembered by their newest grant to this follower and
 * whether it was revoked. A revocation keeps its grant (the owner's record of
 * the answer), so a removal is seen as that grant turning revoked, which
 * takes a read of the feed's rekeys: it is checked when the newest grant
 * changes, and otherwise at most once per {@link REVOKE_CHECK_MS}.
 *
 * - An owner whose newest grant is in force, after none or a revoked one: approved.
 * - An owner whose grant in force turned revoked, or whose grants all went: removed.
 * - A renewal moves the follower to a newer grant in force: nothing.
 *
 * The first look on a device only records the list: nothing old is announced.
 */

export interface HeldGrant {
  ownerId: string
  feed: number
  grantId: string
}

interface Entry {
  /** The newest grant's id. */
  g: string
  /** Whether it was revoked when last checked. */
  r: boolean
  /** When that was checked (ms). */
  t: number
}

export type AccessSnapshot = Record<string, Entry>

/** How often a held grant in force is re-checked for a revocation. */
export const REVOKE_CHECK_MS = 10 * 60 * 1000

export function parseAccessSnapshot(raw: string | null): AccessSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entries = Object.values(parsed as Record<string, unknown>)
    const valid = entries.every((entry) => {
      const e = entry as Partial<Entry>
      return typeof e?.g === 'string' && typeof e.r === 'boolean' && typeof e.t === 'number'
    })
    return valid ? (parsed as AccessSnapshot) : null
  } catch {
    return null
  }
}

/** Each owner's newest grant (highest feed). */
export function newestPerOwner(grants: readonly HeldGrant[]): Map<string, HeldGrant> {
  const newest = new Map<string, HeldGrant>()
  for (const grant of grants) {
    const known = newest.get(grant.ownerId)
    if (!known || grant.feed > known.feed) newest.set(grant.ownerId, grant)
  }
  return newest
}

/** The owners whose newest grant needs a revocation check now: a new grant, or a grant in force not checked for a while. */
export function ownersToCheck(previous: AccessSnapshot | null, newest: ReadonlyMap<string, HeldGrant>, now: number): string[] {
  return [...newest.values()].filter((grant) => {
    const known = previous?.[grant.ownerId]
    return !known || known.g !== grant.grantId || (!known.r && now - known.t >= REVOKE_CHECK_MS)
  }).map((grant) => grant.ownerId)
}

export interface AccessDiff {
  snapshot: AccessSnapshot
  /** Owners who granted access since the last look, with that grant's feed. */
  approved: { ownerId: string; feed: number }[]
  /** Owners who took access away since the last look. */
  removed: string[]
}

/**
 * Diff the newest grants against `previous`. `revoked` holds the result of
 * this look's checks (see {@link ownersToCheck}); unchecked owners keep what
 * the snapshot knew.
 */
export function diffAccess(previous: AccessSnapshot | null, newest: ReadonlyMap<string, HeldGrant>, revoked: ReadonlyMap<string, boolean>, now: number): AccessDiff {
  const snapshot: AccessSnapshot = {}
  for (const grant of newest.values()) {
    const known = previous?.[grant.ownerId]
    const checked = revoked.get(grant.ownerId)
    snapshot[grant.ownerId] = checked === undefined && known ? known : { g: grant.grantId, r: checked ?? false, t: now }
  }
  if (previous === null) return { snapshot, approved: [], removed: [] }
  const approved: AccessDiff['approved'] = []
  const removed: string[] = []
  for (const [ownerId, entry] of Object.entries(snapshot)) {
    const known = previous[ownerId]
    if (!entry.r && (!known || known.r)) approved.push({ ownerId, feed: newest.get(ownerId)?.feed ?? 0 })
    if (entry.r && known && !known.r) removed.push(ownerId)
  }
  for (const [ownerId, known] of Object.entries(previous)) if (!snapshot[ownerId] && !known.r) removed.push(ownerId)
  return { snapshot, approved, removed }
}
