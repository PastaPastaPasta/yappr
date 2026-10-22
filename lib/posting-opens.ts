/**
 * When posting opens, for the "Posting opens on <date>" banner (owner decision
 * of 2026-10-22, DECISIONS-FINAL "Elected teams and interim").
 *
 * A contract registered with a `notYetUsable` interim refuses every write of
 * its moderated types (41200) until masternodes seat its first moderation
 * team. The banner says when that can be, from the chain's election state
 * (`moderationElectionService.getStatus`), never from a local estimate:
 *
 * - a team is seated: posting is open, nothing to announce;
 * - a charter has entered the contest: the contest's own end time. The vote
 *   poll is scheduled at the end of the join window while the sole contender
 *   stands alone, and moves out by the vote window when another enters, so the
 *   chain's end time is the earliest moment a team can be seated at any point;
 * - the contest is decided or its time has passed and no team shows yet: the
 *   seat is written in the next block, "shortly";
 * - no charter has entered the contest: the clock has not started (it starts
 *   with the first elected application), so no date is knowable. Estimating
 *   one from the election delay plus the join window would promise a day
 *   nobody has committed to, so the banner says what posting waits for.
 *
 * Pure (unit-tested); the banner component reads the status and renders this.
 */

/** What the election status says about posting. */
export type PostingOpening =
  /** Posting is open (or the contract is not closed by an interim): nothing to announce. */
  | { kind: 'open' }
  /** The status could not be read well enough to claim anything: announce nothing. */
  | { kind: 'unknown' }
  /** A team can be seated at this time (ms), the contest's end. */
  | { kind: 'at'; atMs: number }
  /** A team is about to be seated: the contest is decided or its end has passed. */
  | { kind: 'soon' }
  /** Closed, and no charter has entered the contest, so no date can be given. */
  | { kind: 'pending' }

/** The part of the election status the answer rests on (a subset of `ElectionStatus`). */
export interface PostingOpeningInput {
  declaration: { interim: string }
  seated: unknown
  contest: { winner: unknown; endsAtMs: number | null } | null
  failures: readonly string[]
}

/** What the election status means for posting at `nowMs`. */
export function postingOpening(status: PostingOpeningInput | null, nowMs: number): PostingOpening {
  if (!status) return { kind: 'unknown' }
  if (status.declaration.interim !== 'notYetUsable') return { kind: 'open' }
  // An empty seat next to a failed seat read is "unknown", never "closed".
  if (status.failures.includes('seatedTeam')) return { kind: 'unknown' }
  if (status.seated) return { kind: 'open' }
  const { contest } = status
  if (!contest) return { kind: 'pending' }
  if (contest.winner) return { kind: 'soon' }
  const end = contest.endsAtMs
  if (end === null || !Number.isFinite(end) || end <= 0) return { kind: 'pending' }
  return end > nowMs ? { kind: 'at', atMs: end } : { kind: 'soon' }
}

/** True when the banner has something to say. */
export function announcesOpening(opening: PostingOpening): boolean {
  return opening.kind === 'at' || opening.kind === 'soon' || opening.kind === 'pending'
}

/** A date and time the way people read them where they are, e.g. "Oct 23, 2026, 3:40 PM". */
export function formatOpeningTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The banner's line, or null when there is nothing to announce. A date that
 * has passed by `nowMs` reads "shortly", never "opens on <past date>".
 */
export function postingOpensText(opening: PostingOpening, formatTime: (ms: number) => string = formatOpeningTime, nowMs: number = Date.now()): string | null {
  switch (opening.kind) {
    case 'at':
      return opening.atMs > nowMs ? `Posting opens on ${formatTime(opening.atMs)}` : 'Posting opens shortly'
    case 'soon':
      return 'Posting opens shortly'
    case 'pending':
      return 'Posting opens once the first moderators are elected'
    default:
      return null
  }
}

/** How long a remembered answer may paint the banner before the chain confirms it. */
export const OPENING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The remembered answer, as stored; null when it is not one that can be shown. */
export function parseCachedOpening(raw: string | null, nowMs: number): PostingOpening | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { kind, atMs, savedAt } = value as { kind?: unknown; atMs?: unknown; savedAt?: unknown }
    if (typeof savedAt !== 'number' || nowMs - savedAt > OPENING_CACHE_MAX_AGE_MS || nowMs < savedAt) return null
    if (kind === 'soon' || kind === 'pending') return { kind }
    // A remembered date that has passed is no date to promise: the seat is due, "shortly".
    if (kind === 'at' && typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0) return atMs > nowMs ? { kind, atMs } : { kind: 'soon' }
    return null
  } catch {
    return null
  }
}

/** The answer in the form {@link parseCachedOpening} reads back. */
export function serializeOpening(opening: PostingOpening, nowMs: number): string {
  return JSON.stringify({ ...opening, savedAt: nowMs })
}
