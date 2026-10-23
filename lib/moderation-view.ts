import type { ModeratedContractKey } from '@/lib/moderated-contracts'

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
 *
 * The moderator view makes the same decision at runtime, one contract at a
 * time: a verified member of a contract's seated team who turns on "Show
 * hidden & restricted" sees that contract the way an archival build shows it.
 * Only the moderator-view store (hooks/use-moderator-view.ts) turns it on,
 * after reading the seated team off the chain, once per page load and before
 * the page mounts; it is off for everyone else.
 */

/** True on an archival build (`NEXT_PUBLIC_MODERATION_VIEW=all`), whoever is signed in. */
export function archivalBuild(): boolean {
  return process.env.NEXT_PUBLIC_MODERATION_VIEW === 'all'
}

/** The contracts the moderator view is on for, in this page load. */
let moderatorView: ReadonlySet<ModeratedContractKey> = new Set()

/**
 * Turns the moderator view on for exactly `contracts`. Only for the contracts
 * on which the signed-in identity is a verified seated moderator
 * ({@link moderatorViewScope}), and only while the page is held, before
 * anything has read ({@link moderatorViewHolds}): any later change of view
 * reloads the page instead, so no read or cache ever spans one.
 */
export function setModeratorViewContracts(contracts: Iterable<ModeratedContractKey>): void {
  moderatorView = new Set(contracts)
}

/**
 * True while the page must not mount: the view was turned on in this tab,
 * and either the session is not restored yet or the identity that turned it
 * on is signed in and its seats are still being read.
 */
export function moderatorViewHolds(state: {
  /** The session was restored and its identity taken. */
  booted: boolean
  viewer: string | null
  /** The identity that turned the view on in this tab. */
  enabledFor: string | null
  /** Whose seats have been read. */
  seatedFor: string | null
}): boolean {
  if (state.enabledFor === null) return false
  if (!state.booted) return true
  return state.viewer === state.enabledFor && state.seatedFor !== state.viewer
}

/**
 * True when the signed-in identity changing (once the page has loaded) must
 * reload the page: the view is on now (signing out of, or switching from, a
 * moderator session), or the identity signing in turned it on in this tab.
 */
export function viewerChangeReloads(state: { activeContracts: number; enabledFor: string | null; nextViewer: string | null }): boolean {
  return state.activeContracts > 0 || (state.nextViewer !== null && state.nextViewer === state.enabledFor)
}

/** The contracts the moderator view is on for now. */
export function moderatorViewContracts(): ReadonlySet<ModeratedContractKey> {
  return moderatorView
}

/**
 * The contracts the moderator view covers: the ones `viewer` is verified as
 * a seated moderator of, once `viewer` turned it on in this tab. Empty for
 * anyone signed out, anyone who turned it off, and anyone whose seats were
 * read for another identity.
 */
export function moderatorViewScope(state: {
  viewer: string | null
  /** Whose seats `seated` lists. */
  seatedFor: string | null
  seated: readonly ModeratedContractKey[]
  enabled: boolean
}): ModeratedContractKey[] {
  if (!state.viewer || !state.enabled || state.seatedFor !== state.viewer) return []
  return [...state.seated]
}

/**
 * True when `contract`'s listings read and show every moderation lane: on an
 * archival build, and for a verified seated moderator of `contract` who
 * turned the moderator view on.
 */
export function moderationViewAll(contract: ModeratedContractKey = 'social'): boolean {
  return archivalBuild() || moderatorView.has(contract)
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
 * True when this build drops a hidden document of `contract` it reached
 * outside a listing (yap.pr's behaviour). An archival build, and the
 * contract's moderators with the moderator view on, keep it and label it.
 */
export function dropsHidden(doc: { mod?: unknown } | null | undefined, contract: ModeratedContractKey = 'social'): boolean {
  return isHidden(doc) && !moderationViewAll(contract)
}

/** The moderator marks a transformed document carries (`moderation`), if any. */
export function moderationOf(doc: object | null | undefined): ModerationMarks | undefined {
  if (!doc || !('moderation' in doc)) return undefined
  const marks = doc.moderation
  return typeof marks === 'object' && marks !== null ? (marks as ModerationMarks) : undefined
}

/** True when this build drops `item` (of `contract`) from a list or a read: a moderator hid it and the viewer is not shown hidden content ({@link dropsHidden}). Items without `moderation` are never dropped. */
export function isHiddenItem(item: object | null | undefined, contract: ModeratedContractKey = 'social'): boolean {
  return dropsHidden(moderationOf(item), contract)
}

/**
 * True when nothing may be done with `item` because a moderator hid it: no
 * reply, quote or repost, no purchase. Everywhere but on an archival build;
 * the moderator view shows hidden content but unlocks nothing on it.
 */
export function actionsBlockedByHide(item: object | null | undefined): boolean {
  return isHidden(moderationOf(item)) && !archivalBuild()
}

/** `items` (of `contract`) without the ones this build drops as hidden ({@link isHiddenItem}), in order. */
export function withoutHiddenItems<T extends object>(items: readonly T[], contract: ModeratedContractKey = 'social'): T[] {
  return items.filter((item) => !isHiddenItem(item, contract))
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
