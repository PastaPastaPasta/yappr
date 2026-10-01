/**
 * Timeless like notifications (v11, `likeNotificationsAreTimeless`).
 *
 * No v11 like index keeps a like's time, so "who liked my content since the
 * last poll" cannot be asked of the chain. Instead this device keeps a
 * snapshot, per user, of who had liked each of their recent posts and replies,
 * and each poll diffs the likers of every target whose like count moved
 * against it. New likers of one target become ONE batch ("Alice and 3 others
 * liked your post"), dated when this device first noticed them.
 *
 * The first poll of a kind (no snapshot yet, e.g. a new device) only records
 * the baseline: old likes never notify. Neither does a target that re-enters
 * the recent window from below it (a newer post was deleted): it is older than
 * the window's previous horizon, so it is recorded silently too. Pure: no
 * chain, no storage.
 */

import type { TargetKind } from './contract-topology'

/** One aggregated like notification: new likers of one target, noticed together. */
export interface LikeBatch {
  /** `like:<kind>:<targetId>:<firstSeenMs>`, stable for the life of the batch. */
  id: string
  kind: TargetKind
  targetId: string
  /** When this device first noticed these likers (there is no on-chain time). */
  firstSeenMs: number
  /** The first {@link MAX_BATCH_LIKERS} new likers' identity ids. */
  likers: string[]
  /** How many new likers the batch holds (may exceed `likers.length`). */
  total: number
}

/** What the snapshot knows of one target. */
interface TrackedTarget {
  /** The like count the likers below were read at. */
  count: number
  /**
   * Every liker's identity id, or null when the target had more likers than
   * are tracked ({@link MAX_TRACKED_LIKERS}) or a read covers: its new likers
   * can then not be told apart and do not notify.
   */
  likers: string[] | null
}

export interface LikeSnapshot {
  v: 1
  /** Kinds whose baseline is recorded; a kind not listed is baselined silently. */
  baselined: TargetKind[]
  /** Per kind, the `$createdAt` of the oldest target in the recent window last observed. */
  horizons: Partial<Record<TargetKind, number>>
  /** Liked recent targets, keyed `<kind>:<targetId>`. Unliked ones are not kept. */
  targets: Record<string, TrackedTarget>
  /** Batches of the last {@link BATCH_RETENTION_MS}, newest last. */
  batches: LikeBatch[]
}

/** A recent post or reply of the user's: its like count and its own `$createdAt`. */
export interface RecentTarget {
  count: number
  createdAtMs: number
}

/** One poll's view of one kind: the recent targets' counts and the likers re-read. */
export interface KindObservation {
  kind: TargetKind
  /** Every recent target of this kind, newest first, zero counts included. */
  targets: ReadonlyMap<string, RecentTarget>
  /** Likers of the targets {@link targetsToRead} named; `complete` false when the read was cut short. */
  likers: ReadonlyMap<string, { likers: readonly string[]; complete: boolean }>
}

/** Batches older than this are dropped: the initial notification fetch covers 7 days. */
const BATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BATCHES = 100
const MAX_BATCH_LIKERS = 10
/**
 * Targets of one kind whose likers one poll reads (each is its own query, plus
 * pages). The rest keep their stale count in the snapshot and are read on a
 * later poll, newest first.
 */
const MAX_TARGETS_READ_PER_POLL = 10
/** Likers kept per target; past it the target stops naming new likers (keeps the snapshot small). */
const MAX_TRACKED_LIKERS = 200

const targetKey = (kind: TargetKind, targetId: string) => `${kind}:${targetId}`

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isKind = (value: unknown): value is TargetKind => value === 'post' || value === 'reply'

function isBatch(value: unknown): value is LikeBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Record<string, unknown>
  return typeof batch.id === 'string' && isKind(batch.kind) && typeof batch.targetId === 'string'
    && typeof batch.firstSeenMs === 'number' && isStringArray(batch.likers) && batch.likers.length > 0
    && typeof batch.total === 'number'
}

function isTracked(value: unknown): value is TrackedTarget {
  if (!value || typeof value !== 'object') return false
  const tracked = value as Record<string, unknown>
  return typeof tracked.count === 'number' && (tracked.likers === null || isStringArray(tracked.likers))
}

/** Read a stored snapshot; null when absent or unreadable (the next poll then re-baselines). */
export function parseLikeSnapshot(raw: string | null): LikeSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed?.v !== 1 || !Array.isArray(parsed.baselined) || !Array.isArray(parsed.batches)
      || !parsed.targets || typeof parsed.targets !== 'object') return null
    const targets = Object.entries(parsed.targets as Record<string, unknown>)
      .filter((entry): entry is [string, TrackedTarget] => isTracked(entry[1]))
    const horizons = parsed.horizons && typeof parsed.horizons === 'object' ? parsed.horizons as Record<string, unknown> : {}
    return {
      v: 1,
      baselined: parsed.baselined.filter(isKind),
      horizons: Object.fromEntries(Object.entries(horizons).filter(([kind, at]) => isKind(kind) && typeof at === 'number')),
      targets: Object.fromEntries(targets),
      batches: parsed.batches.filter(isBatch),
    }
  } catch {
    return null
  }
}

/** Whether a liked target's likers are already known at this count. */
function isCurrent(snapshot: LikeSnapshot | null, kind: TargetKind, targetId: string, count: number): boolean {
  return snapshot?.targets[targetKey(kind, targetId)]?.count === count
}

/**
 * The targets of `kind` whose likers must be read this poll, newest first and
 * at most {@link MAX_TARGETS_READ_PER_POLL}: every liked one whose count moved
 * since the snapshot, or that it does not hold (a fall is re-read too, so an
 * unliker who likes again later is noticed).
 */
export function targetsToRead(snapshot: LikeSnapshot | null, kind: TargetKind, recent: ReadonlyMap<string, RecentTarget>): string[] {
  return [...recent]
    .filter(([targetId, { count }]) => count > 0 && !isCurrent(snapshot, kind, targetId, count))
    .map(([targetId]) => targetId)
    .slice(0, MAX_TARGETS_READ_PER_POLL)
}

/**
 * Fold one poll into the snapshot. Kinds not observed (their read failed) are
 * carried over untouched; an observed kind keeps only its current recent
 * targets. Returns the next snapshot and the batches this poll created.
 *
 * A complete re-read is merged into the known likers unless the count fell (a
 * liker missing from one lagging read is not forgotten, so not announced
 * again later). A read listing fewer likers than the count (counts and likers
 * served by nodes at different heights) stores the smaller count, so the next
 * poll reads the target again. A liker already named by a retained batch of
 * the same target is not named again.
 */
export function applyLikeObservations(
  previous: LikeSnapshot | null,
  observed: readonly KindObservation[],
  { selfId, nowMs }: { selfId: string; nowMs: number }
): { snapshot: LikeSnapshot; fresh: LikeBatch[] } {
  const observedKinds = new Set(observed.map(({ kind }) => kind))
  const targets: Record<string, TrackedTarget> = Object.fromEntries(
    Object.entries(previous?.targets ?? {}).filter(([key]) => !observedKinds.has(key.split(':')[0] as TargetKind))
  )
  const horizons: Partial<Record<TargetKind, number>> = { ...previous?.horizons }
  const fresh: LikeBatch[] = []
  const baselinedKinds = new Set(previous?.baselined ?? [])
  const named = new Map<string, Set<string>>()
  for (const batch of previous?.batches ?? []) {
    const key = targetKey(batch.kind, batch.targetId)
    named.set(key, new Set([...(named.get(key) ?? []), ...batch.likers]))
  }

  for (const { kind, targets: recent, likers } of observed) {
    const baselined = baselinedKinds.has(kind)
    const horizon = previous?.horizons[kind]
    // A baseline is recorded once every liked target has been read (the
    // per-poll cap may spread it over several polls, all silent).
    const unread = [...recent].some(([targetId, { count }]) => count > 0 && !likers.has(targetId) && !isCurrent(previous, kind, targetId, count))
    if (!unread) baselinedKinds.add(kind)
    if (recent.size > 0) horizons[kind] = Math.min(...[...recent.values()].map(({ createdAtMs }) => createdAtMs))

    for (const [targetId, { count, createdAtMs }] of recent) {
      if (count <= 0) continue
      const key = targetKey(kind, targetId)
      const before = previous?.targets[key]
      const read = likers.get(targetId)
      if (!read) {
        // Not re-read: the count did not move (or the cap deferred it), so what was known still holds.
        if (before) targets[key] = before
        continue
      }
      // A fall replaces the known likers only with a read that covers the new
      // count: a node a block behind could otherwise forget likers it lists
      // again next poll, and they would be announced a second time.
      const fell = before !== undefined && count < before.count
      const trustRead = fell && read.likers.length >= count
      const merged = trustRead || !before?.likers ? [...read.likers] : Array.from(new Set([...before.likers, ...read.likers]))
      if (!read.complete || merged.length > MAX_TRACKED_LIKERS) {
        targets[key] = { count, likers: null }
        continue
      }
      targets[key] = { count: Math.min(count, read.likers.length), likers: merged }
      // Silent: no baseline yet, the previous read could not list everyone, or
      // the target re-entered the window from below its previous horizon.
      const reentered = before === undefined && horizon !== undefined && createdAtMs < horizon
      if (!baselined || before?.likers === null || reentered) continue
      const known = new Set([...(before?.likers ?? []), ...(named.get(key) ?? [])])
      const added = read.likers.filter((liker) => !known.has(liker) && liker !== selfId)
      if (added.length === 0) continue
      fresh.push({
        id: `like:${kind}:${targetId}:${nowMs}`,
        kind,
        targetId,
        firstSeenMs: nowMs,
        likers: added.slice(0, MAX_BATCH_LIKERS),
        total: added.length,
      })
    }
  }

  const baselined = Array.from(baselinedKinds)
  const batches = [...(previous?.batches ?? []), ...fresh]
    .filter((batch) => batch.firstSeenMs > nowMs - BATCH_RETENTION_MS)
    .slice(-MAX_BATCHES)
  return { snapshot: { v: 1, baselined, horizons, targets, batches }, fresh }
}
