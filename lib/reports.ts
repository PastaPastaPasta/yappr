/**
 * Reporting a post, a reply or (v13) a profile to the social contract's
 * moderators: the `report` document type (docs/CONTRACTS_BETA6.md,
 * docs/SOCIAL_V13.md §4) and the queue the moderators work from.
 *
 * What consensus enforces on a report:
 * - it names exactly one target, `postId` or `replyId`, or on v13 the
 *   identity itself (`about: 1`, a profile report) (`oneTarget`, 10422);
 * - `targetOwnerId` is the target's author (40127) and never the reporter
 *   (10419), so the queue can name the author even once the target is gone;
 * - one report per reporter and target (the `ownerAndPost` / `ownerAndReply`
 *   unique indexes, 40105);
 * - "something else" must say what (`otherHasNote`, 10422);
 * - reports are immutable: the reporter withdraws one by deleting it. On v9
 *   the moderators dismiss one by deleting it as moderators (a removal
 *   record); on v10 they resolve it instead, writing `status` and
 *   `resolution` with `moderatorChangeDocumentFields`, which stamps
 *   `$moderatedBy`/`$moderatedAt` and keeps the report (a reporter who sets
 *   either field is refused 41124);
 * - a report expires 90 days after it was filed (\`ttl\`), refunding nothing,
 *   resolved or not.
 *
 * A report is public: anyone can read who reported what, and why, and how the
 * moderators resolved it.
 */
import { declaredActionFee, reportShape, type TargetKind } from './contract-topology'
import { categorizeError, extractErrorMessage, hasConsensusCode, isReferenceNotFoundError } from './error-utils'
import { normalizeBytes } from './bytes'
import { identifierToBase58 } from './services/sdk-helpers'

export interface ReportReason {
  /** The `reason` value stored on chain; fixed once the contract is registered. */
  code: number
  label: string
  hint: string
}

/**
 * Stored as its code, so the order and codes are frozen with the contract
 * (`reason` 0..8, and 9 from v13: see {@link reportReasonsOffered}).
 */
export const REPORT_REASONS: readonly ReportReason[] = Object.freeze([
  { code: 0, label: 'Spam or scam', hint: 'Repetitive, misleading or fraudulent content' },
  { code: 1, label: 'Harassment or bullying', hint: 'Targeting, insulting or intimidating someone' },
  { code: 2, label: 'Hate', hint: 'Attacking people for who they are' },
  { code: 3, label: 'Violence or threats', hint: 'Threatening, inciting or glorifying violence' },
  { code: 4, label: 'Sexual content', hint: 'Explicit sexual content' },
  { code: 5, label: 'Self-harm', hint: 'Encouraging suicide or self-injury' },
  { code: 6, label: 'Illegal goods or activity', hint: 'Selling or promoting something illegal' },
  { code: 7, label: 'Impersonation', hint: 'Pretending to be someone else' },
  { code: 8, label: 'Something else', hint: 'Say what in the details' },
  { code: 9, label: 'Child sexual abuse material', hint: 'Sexual content involving minors' },
].map((reason) => Object.freeze(reason)))

/**
 * Sexual content involving minors (v13): the moderators' queue puts it first
 * and flags it urgent, and the reporter is pointed at the authorities and the
 * team's email as well (a report is public, the material must not be repeated).
 */
export const URGENT_REASON_CODE = 9

export function isUrgentReason(code: number): boolean {
  return code === URGENT_REASON_CODE
}

/** The reasons the configured contract accepts (`reason.maximum`): 0..8, or 0..9 on v13. */
export function reportReasonsOffered(): readonly ReportReason[] {
  const { maxReason } = reportShape()
  return REPORT_REASONS.filter((reason) => reason.code <= maxReason)
}

/** What a report names: a post, a reply, or (v13 `about: 1`) the identity's profile. */
export type ReportTargetKind = TargetKind | 'profile'

/** `report.about` for a profile report (v13). */
export const ABOUT_PROFILE = 1

/**
 * Where reports go when the chain cannot carry them: the team's email
 * (`support@yap.pr`, the address the mobile apps use), for a private post no
 * moderator holds an encryption key to read, or anything urgent.
 */
export const MODERATION_EMAIL = 'support@yap.pr'

/** A `mailto:` for reporting `target` by email, naming it and the reason (never the content). */
export function reportEmailHref(target: { kind: ReportTargetKind; targetId: string }, reasonCode: number): string {
  const subject = `Yappr report: ${reportReasonLabel(reasonCode)}`
  const body = `Reported ${target.kind}: ${target.targetId}\n\nWhat is wrong with it:\n`
  return `mailto:${MODERATION_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** The moderators' action fee a report pays, in credits (v13: 50M), or null where reports are free. */
export function reportFeeCredits(): bigint | null {
  const fee = declaredActionFee('report', 'create')
  return fee ? fee.owner + fee.moderators : null
}

/** "Something else": the contract refuses it without a note (`otherHasNote`). */
export const OTHER_REASON_CODE = 8

/** `report.note` maxLength. */
export const REPORT_NOTE_MAX_LENGTH = 500

export function reportReasonLabel(code: number): string {
  return REPORT_REASONS.find((reason) => reason.code === code)?.label ?? `Reason ${code}`
}

/**
 * Why a report cannot be filed as given, or null when it can: the checks the
 * contract would refuse it for, made before anything is signed.
 */
export function reportInputProblem(reason: number | null, note: string): string | null {
  if (reason === null || !reportReasonsOffered().some((known) => known.code === reason)) return 'Choose why you are reporting this'
  const trimmed = note.trim()
  if (reason === OTHER_REASON_CODE && trimmed.length === 0) return 'Say what is wrong with it'
  if (trimmed.length > REPORT_NOTE_MAX_LENGTH) return `Keep the details to ${REPORT_NOTE_MAX_LENGTH} characters`
  return null
}

/**
 * A second report of the same target by the same reporter (the unique
 * `ownerAndPost` / `ownerAndReply` index, v13 `byPost` / `byReply` /
 * `byTarget`, 40105): the first one stands.
 */
export function isAlreadyReportedError(error: unknown): boolean {
  return /duplicate unique properties|duplicateuniqueindex/i.test(extractErrorMessage(error)) || hasConsensusCode(error, [40105])
}

/** What to tell a reporter whose report was refused. */
export function reportFailureMessage(error: unknown, noun: ReportTargetKind): string {
  if (isAlreadyReportedError(error)) return `You have already reported this ${noun}.`
  // 40120 on postId/replyId: a moderator removed it (or it never existed).
  if (noun !== 'profile' && isReferenceNotFoundError(error)) return `This ${noun} has been removed, so there is nothing to report.`
  return categorizeError(error)
}

/**
 * The report a reporter tried to withdraw no longer exists (40101): a moderator
 * dismissed it, or it was withdrawn from another device.
 */
export function isReportGoneError(error: unknown): boolean {
  return /documentnotfounderror|[1-9A-HJ-NP-Za-km-z]{32,44} document not found/i.test(extractErrorMessage(error)) ||
    hasConsensusCode(error, [40101])
}

/** What to tell a reporter whose withdrawal was refused. */
export function withdrawFailureMessage(error: unknown): string {
  if (isReportGoneError(error)) return 'This report is already gone: the moderators dismissed it, or it was withdrawn elsewhere.'
  return categorizeError(error)
}

/**
 * How the moderators resolved a report (v10 `report.status`). Stored as its
 * code, so the codes are frozen with the contract (`status` 1..3).
 */
export type ReportStatus = 1 | 2 | 3

export const REPORT_STATUSES: ReadonlyArray<Readonly<{ code: ReportStatus; label: string; hint: string }>> = Object.freeze([
  { code: 1 as const, label: 'No action taken', hint: 'Reviewed: nothing here breaks the rules' },
  { code: 2 as const, label: 'Content removed', hint: 'The post or reply was taken down' },
  { code: 3 as const, label: 'Author actioned', hint: 'The author was warned, suspended or banned' },
].map((status) => Object.freeze(status)))

/** `report.resolution` maxLength (v10). */
export const REPORT_RESOLUTION_MAX_LENGTH = 200

export function reportStatusLabel(status: number): string {
  return REPORT_STATUSES.find((known) => known.code === status)?.label ?? `Status ${status}`
}

function isReportStatus(value: unknown): value is ReportStatus {
  return value === 1 || value === 2 || value === 3
}

/**
 * Why a resolution cannot be written as given, or null when it can: a status
 * the contract accepts and a note of at most 200 characters. A blank note is
 * left out rather than sent (`resolution` has a minLength of 1).
 */
export function resolutionInputProblem(status: number | null, resolution: string): string | null {
  if (!isReportStatus(status)) return 'Choose how the report was resolved'
  if (resolution.trim().length > REPORT_RESOLUTION_MAX_LENGTH) return `Keep the resolution to ${REPORT_RESOLUTION_MAX_LENGTH} characters`
  return null
}

/** One report, as the app models it. */
export interface ReportRecord {
  id: string
  reporterId: string
  kind: ReportTargetKind
  /** The post or reply id, or for a profile report the reported identity. */
  targetId: string
  targetOwnerId: string
  reason: number
  note: string | null
  /** Block time (ms) the report was filed. */
  createdAt: number
  /** How the moderators resolved it (v10); null while it is open, and always on v9. */
  status: ReportStatus | null
  /** The moderators' resolution note (v10), or null. */
  resolution: string | null
  /** The last moderator to write `status`/`resolution` (`$moderatedBy`, v10), or null. */
  moderatedBy: string | null
  /** Block time (ms) of that write (`$moderatedAt`, v10), or null. */
  moderatedAt: number | null
  /** v13: the moderators' key to a reported private post or reply (`lib/report-box.ts`), or null. */
  box: Uint8Array | null
}

/**
 * Which reports the moderators' queue lists: the ones nobody has resolved yet
 * (on v9 that is every report, since a handled one is deleted), the ones
 * resolved with one status (`byStatus`), or the ones one moderator resolved
 * last (`byModerator`).
 */
export type ReportView =
  | { kind: 'open' }
  | { kind: 'status'; status: ReportStatus }
  | { kind: 'moderatedBy'; moderatorId: string }

export const OPEN_REPORTS: ReportView = Object.freeze({ kind: 'open' })

/** True when `report` belongs in `view`: the test the view's query makes, for reports resolved here since. */
export function reportMatchesView(report: Pick<ReportRecord, 'status' | 'moderatedBy'>, view: ReportView): boolean {
  switch (view.kind) {
    case 'open':
      return report.status === null
    case 'status':
      return report.status === view.status
    case 'moderatedBy':
      return report.moderatedBy === view.moderatorId
  }
}

/**
 * The reports a resolution would actually change. A report already holding
 * exactly this status and note is left out: a moderator's change that writes
 * the values a document already holds is refused (10905).
 */
export function reportsNeedingResolution<T extends Pick<ReportRecord, 'status' | 'resolution'>>(
  reports: readonly T[],
  status: ReportStatus,
  resolution: string | null
): T[] {
  return reports.filter((report) => report.status !== status || report.resolution !== resolution)
}

/**
 * What a row's resolution form starts from. Open reports start at content
 * removed on a removed target and no action otherwise, with no note. Resolved
 * reports start at the status and note they share, so changing one keeps the
 * other. Where they differ nothing is filled in: the status is left unchosen
 * (`statusesDiffer`), and `notesDiffer` warns that the note replaces them all.
 */
export function resolutionFormStart(
  reports: ReadonlyArray<Pick<ReportRecord, 'status' | 'resolution'>>,
  removed: boolean
): { status: ReportStatus | null; note: string; statusesDiffer: boolean; notesDiffer: boolean } {
  const statuses = new Set(reports.map((report) => report.status))
  const notes = new Set(reports.map((report) => report.resolution))
  const statusesDiffer = statuses.size > 1
  const notesDiffer = notes.size > 1
  const [sharedStatus] = statuses
  const [sharedNote] = notes
  return {
    status: statusesDiffer ? null : sharedStatus ?? (removed ? 2 : 1),
    note: notesDiffer ? '' : sharedNote ?? '',
    statusesDiffer,
    notesDiffer,
  }
}

/**
 * A raw `report` document as a {@link ReportRecord}, or null when it names no
 * target, no target owner or no integer reason (consensus refuses each, so only
 * a malformed read produces one).
 */
export function toReportRecord(doc: Record<string, unknown>): ReportRecord | null {
  const data = (doc.data ?? doc) as Record<string, unknown>
  const postId = identifierToBase58(data.postId ?? doc.postId)
  const replyId = identifierToBase58(data.replyId ?? doc.replyId)
  const id = identifierToBase58(doc.$id ?? doc.id)
  const reporterId = identifierToBase58(doc.$ownerId ?? doc.ownerId)
  const targetOwnerId = identifierToBase58(data.targetOwnerId ?? doc.targetOwnerId)
  const aboutProfile = Number(data.about ?? doc.about) === ABOUT_PROFILE
  const targetId = postId ?? replyId ?? (aboutProfile ? targetOwnerId : null)
  const reason = Number(data.reason ?? doc.reason)
  // Consensus requires both; a read missing either is malformed, not a report.
  if (!targetId || !id || !reporterId || !targetOwnerId || !Number.isInteger(reason)) return null
  const note = data.note ?? doc.note
  const status = Number(data.status ?? doc.status)
  const resolution = data.resolution ?? doc.resolution
  const moderatedAt = Number(doc.$moderatedAt ?? 0)
  const box = normalizeBytes(data.box ?? doc.box)
  return {
    id,
    reporterId,
    kind: postId ? 'post' : replyId ? 'reply' : 'profile',
    targetId,
    targetOwnerId,
    reason,
    note: typeof note === 'string' && note.length > 0 ? note : null,
    createdAt: Number(doc.$createdAt ?? doc.createdAt ?? 0),
    status: isReportStatus(status) ? status : null,
    resolution: typeof resolution === 'string' && resolution.length > 0 ? resolution : null,
    moderatedBy: identifierToBase58(doc.$moderatedBy),
    moderatedAt: Number.isFinite(moderatedAt) && moderatedAt > 0 ? moderatedAt : null,
    box: box && box.length > 0 ? box : null,
  }
}

/** Every report on one post, reply or profile: one row of the moderators' queue. */
export interface ReportedTarget {
  kind: ReportTargetKind
  targetId: string
  targetOwnerId: string
  /** Newest first. */
  reports: ReportRecord[]
  /** Block time (ms) of the newest report. */
  latestAt: number
  /** Each reason given, most-given first (ties by code). */
  reasonCounts: Array<{ code: number; count: number }>
  /** True when any report gives the urgent reason ({@link isUrgentReason}). */
  urgent: boolean
}

const targetKey = (kind: ReportTargetKind, targetId: string) => `${kind}:${targetId}`

/**
 * Groups reports by what they report: urgent targets first, then the
 * newest-reported. A report seen twice (overlapping pages) counts once.
 */
export function groupReports(reports: readonly ReportRecord[]): ReportedTarget[] {
  const byTarget = new Map<string, Map<string, ReportRecord>>()
  for (const report of reports) {
    const key = targetKey(report.kind, report.targetId)
    const group = byTarget.get(key) ?? new Map<string, ReportRecord>()
    group.set(report.id, report)
    byTarget.set(key, group)
  }
  return Array.from(byTarget.values(), (group) => {
    const sorted = Array.from(group.values()).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const counts = new Map<number, number>()
    for (const report of sorted) counts.set(report.reason, (counts.get(report.reason) ?? 0) + 1)
    const [newest] = sorted
    return {
      kind: newest.kind,
      targetId: newest.targetId,
      targetOwnerId: newest.targetOwnerId,
      reports: sorted,
      latestAt: newest.createdAt,
      reasonCounts: Array.from(counts, ([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code),
      urgent: sorted.some((report) => isUrgentReason(report.reason)),
    }
  }).sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.latestAt - a.latestAt || targetKey(a.kind, a.targetId).localeCompare(targetKey(b.kind, b.targetId)))
}
