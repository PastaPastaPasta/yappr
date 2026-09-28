/**
 * Reporting a post or reply to the social contract's moderators: the v9
 * `report` document type (docs/CONTRACTS_BETA6.md) and the queue the
 * moderators work from.
 *
 * What consensus enforces on a report:
 * - it names exactly one target, `postId` or `replyId` (`oneTarget`, 10422);
 * - `targetOwnerId` is the target's author (40127) and never the reporter
 *   (10419), so the queue can name the author even once the target is gone;
 * - one report per reporter and target (the `ownerAndPost` / `ownerAndReply`
 *   unique indexes, 40105);
 * - "something else" must say what (`otherHasNote`, 10422);
 * - reports are immutable: the reporter withdraws one by deleting it, and the
 *   moderators dismiss one by deleting it as moderators (a removal record);
 * - a report expires 90 days after it was filed (\`ttl\`), refunding nothing.
 *
 * A report is public: anyone can read who reported what, and why.
 */
import type { TargetKind } from './contract-topology'
import { categorizeError, extractErrorMessage, hasConsensusCode, isReferenceNotFoundError } from './error-utils'
import { identifierToBase58 } from './services/sdk-helpers'

export interface ReportReason {
  /** The `reason` value stored on chain; fixed once the contract is registered. */
  code: number
  label: string
  hint: string
}

/** Stored as its code, so the order and codes are frozen with the contract (`reason` 0..8). */
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
].map((reason) => Object.freeze(reason)))

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
  if (reason === null || !REPORT_REASONS.some((known) => known.code === reason)) return 'Choose why you are reporting this'
  const trimmed = note.trim()
  if (reason === OTHER_REASON_CODE && trimmed.length === 0) return 'Say what is wrong with it'
  if (trimmed.length > REPORT_NOTE_MAX_LENGTH) return `Keep the details to ${REPORT_NOTE_MAX_LENGTH} characters`
  return null
}

/**
 * A second report of the same target by the same reporter (the unique
 * `ownerAndPost` / `ownerAndReply` index, 40105): the first one stands.
 */
export function isAlreadyReportedError(error: unknown): boolean {
  return /duplicate unique properties|duplicateuniqueindex/i.test(extractErrorMessage(error)) || hasConsensusCode(error, [40105])
}

/** What to tell a reporter whose report was refused. */
export function reportFailureMessage(error: unknown, noun: 'post' | 'reply'): string {
  if (isAlreadyReportedError(error)) return `You have already reported this ${noun}.`
  // 40120 on postId/replyId: a moderator removed it (or it never existed).
  if (isReferenceNotFoundError(error)) return `This ${noun} has been removed, so there is nothing to report.`
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

/** One report, as the app models it. */
export interface ReportRecord {
  id: string
  reporterId: string
  kind: TargetKind
  targetId: string
  targetOwnerId: string
  reason: number
  note: string | null
  /** Block time (ms) the report was filed. */
  createdAt: number
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
  const targetId = postId ?? replyId
  const id = identifierToBase58(doc.$id ?? doc.id)
  const reporterId = identifierToBase58(doc.$ownerId ?? doc.ownerId)
  const targetOwnerId = identifierToBase58(data.targetOwnerId ?? doc.targetOwnerId)
  const reason = Number(data.reason ?? doc.reason)
  // Consensus requires both; a read missing either is malformed, not a report.
  if (!targetId || !id || !reporterId || !targetOwnerId || !Number.isInteger(reason)) return null
  const note = data.note ?? doc.note
  return {
    id,
    reporterId,
    kind: postId ? 'post' : 'reply',
    targetId,
    targetOwnerId,
    reason,
    note: typeof note === 'string' && note.length > 0 ? note : null,
    createdAt: Number(doc.$createdAt ?? doc.createdAt ?? 0),
  }
}

/** Every report on one post or reply: one row of the moderators' queue. */
export interface ReportedTarget {
  kind: TargetKind
  targetId: string
  targetOwnerId: string
  /** Newest first. */
  reports: ReportRecord[]
  /** Block time (ms) of the newest report. */
  latestAt: number
  /** Each reason given, most-given first (ties by code). */
  reasonCounts: Array<{ code: number; count: number }>
}

const targetKey = (kind: TargetKind, targetId: string) => `${kind}:${targetId}`

/**
 * Groups reports by what they report, newest-reported target first. A report
 * seen twice (overlapping pages) counts once.
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
    }
  }).sort((a, b) => b.latestAt - a.latestAt || targetKey(a.kind, a.targetId).localeCompare(targetKey(b.kind, b.targetId)))
}
