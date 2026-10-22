/**
 * What a build shows of moderated content (docs/ARCHIVE_FRONTEND.md).
 *
 * yap.pr and the official apps read only the listed lane of every listing
 * (`live == 1, mod == null` on social v18, blog v10 and storefront v11) and
 * drop any hidden document they reach some other way (by id, through a ranked
 * list, a quote, a bookmark or a notification). Two build flags, off by
 * default and refused by the release build (scripts/release-config.cjs), turn
 * a build into an archival or "uncensored" frontend:
 *
 * - `NEXT_PUBLIC_MODERATION_VIEW=all`: every listing reads every lane and
 *   merges them (lib/services/sdk-lane-fanout.ts), counts are the sum of the
 *   lanes, ranked lists keep hidden posts, and hidden or restricted content is
 *   shown with a label instead of being dropped;
 * - `NEXT_PUBLIC_MODERATION_LOG=1`: the `/moderation-log` page lists the
 *   moderation actions on the configured contracts.
 *
 * Each reads `process.env` directly so Next.js (and the mobile engine's
 * bundler) inlines the value at build time.
 */

/** True on an archival build that reads and shows every moderation lane. */
export function moderationViewAll(): boolean {
  return process.env.NEXT_PUBLIC_MODERATION_VIEW === 'all'
}

/** True on a build that serves the moderation log page. */
export function moderationLogEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MODERATION_LOG === '1'
}

/** The moderator-only fields a v18 / blog v10 / storefront v11 document may carry. */
export interface ModerationMarks {
  /** 1 hidden, 2 legal hold; absent when listed. */
  mod?: number
  /** The charter reason or label class (1–63) given when hiding. */
  modLabel?: number
  /** The member who last set or cleared `mod` (base58), and when (ms). */
  moderatedBy?: string
  moderatedAt?: number
}

/** True when a document's moderator-only `mod` is set: a moderator hid it (1) or placed it on legal hold (2). */
export function isHidden(doc: { mod?: unknown } | null | undefined): boolean {
  return typeof doc?.mod === 'number' && doc.mod > 0
}

/**
 * True when this build drops a hidden document it reached outside a listing
 * (yap.pr's behaviour). An archival build keeps it and labels it.
 */
export function dropsHidden(doc: { mod?: unknown } | null | undefined): boolean {
  return isHidden(doc) && !moderationViewAll()
}

/** The moderator marks a transformed document carries (`moderation`), if any. */
export function moderationOf(doc: object | null | undefined): ModerationMarks | undefined {
  if (!doc || !('moderation' in doc)) return undefined
  const marks = doc.moderation
  return typeof marks === 'object' && marks !== null ? (marks as ModerationMarks) : undefined
}

/** True when this build drops `item` from a list or a read: a moderator hid it and the build is not archival. Items without `moderation` are never dropped. */
export function isHiddenItem(item: object | null | undefined): boolean {
  return dropsHidden(moderationOf(item))
}

/** `items` without the ones this build drops as hidden ({@link isHiddenItem}), in order. */
export function withoutHiddenItems<T extends object>(items: readonly T[]): T[] {
  return items.filter((item) => !isHiddenItem(item))
}

/** Reads the moderator-only fields off a plain document (`mod`, `modLabel`, `$moderatedBy`, `$moderatedAt`). */
export function moderationMarksOf(doc: Record<string, unknown>): ModerationMarks {
  const marks: ModerationMarks = {}
  if (isHidden(doc)) marks.mod = doc.mod as number
  if (typeof doc.modLabel === 'number' && doc.modLabel > 0) marks.modLabel = doc.modLabel
  const by = doc.$moderatedBy
  if (typeof by === 'string' && by) marks.moderatedBy = by
  const at = doc.$moderatedAt
  const atMs = typeof at === 'number' ? at : typeof at === 'bigint' ? Number(at) : typeof at === 'string' && /^\d+$/.test(at) ? Number(at) : NaN
  if (Number.isFinite(atMs) && atMs > 0) marks.moderatedAt = atMs
  return marks
}
