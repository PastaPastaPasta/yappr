/**
 * What a moderator's hide or restriction says, as people read it (social v18,
 * blog v10, storefront v11: "hide, don't delete", docs/SOCIAL_V18.md).
 *
 * A hide carries `modLabel` and a restriction `reason`, both an integer 1–63.
 * Yappr writes the chosen charter reason's place (1-based) in the seated
 * team's reason list, and reads it back against that list. While no team is
 * seated (an appointed interim, as on devnet copies) there is no charter, so
 * the label is a report reason class instead (its code + 1). A testnet or
 * mainnet set registers `notYetUsable`, so nobody hides before a team sits.
 *
 * Pure: the hooks in hooks/use-moderation-label.ts read the charter and the
 * moderator's name; components/moderation/moderation-label.tsx renders.
 */
import { REPORT_REASONS } from '@/lib/reports'
import { isHidden, type ModerationMarks } from '@/lib/moderation-view'

/** One reason a moderator may hide or restrict for, and the label it writes. */
export interface LabelOption {
  /** What `modLabel` / `restriction.reason` holds (1–63). */
  label: number
  /** How people read it ("Spam or scam"). */
  text: string
  /** The charter `reason` document the transition cites (a seated team must, 41203); absent for an interim class. */
  reasonDocumentId?: string
}

/** A seated charter's reason, as moderation-election-service reads it. */
export interface CharterReasonLike {
  id: string
  code: string
  label: string
}

const MAX_LABEL = 63

/** The labels the interim offers when no team is seated: the report reasons, each its code + 1. */
export const INTERIM_LABELS: readonly LabelOption[] = Object.freeze(
  REPORT_REASONS.map((reason) => Object.freeze({ label: reason.code + 1, text: reason.label }))
)

/**
 * The reasons a moderator picks from: the seated charter's, each labelled with
 * its place in the list, or the interim classes when no team is seated
 * (`reasons` null). An empty charter list offers nothing: the team can cite
 * no reason, so it can take no such action.
 */
export function labelOptions(reasons: readonly CharterReasonLike[] | null): readonly LabelOption[] {
  if (reasons === null) return INTERIM_LABELS
  return reasons.slice(0, MAX_LABEL).map((reason, index) => ({
    label: index + 1,
    text: reason.label || reason.code,
    reasonDocumentId: reason.id,
  }))
}

/** The reason text for `label`, or null when it cannot be read (an unknown label, or a charter not yet read). */
export function labelText(label: number | null | undefined, reasons: readonly CharterReasonLike[] | null): string | null {
  if (typeof label !== 'number') return null
  return labelOptions(reasons).find((option) => option.label === label)?.text ?? null
}

/** "Spam or scam" → "spam or scam" for the middle of a sentence; an acronym or a name keeps its case. */
export function reasonInSentence(text: string): string {
  if (text.length < 2) return text.toLowerCase()
  const [first, second] = text
  return second === second.toLowerCase() ? first.toLowerCase() + text.slice(1) : text
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function relativeTime(atMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - atMs) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`
  const date = new Date(atMs)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The label line of a restricted account's post; the component picks its icon by it. */
export const RESTRICTED_LINE = 'Restricted account'

export interface ModerationLabelInput {
  marks?: ModerationMarks | null
  /** Written while its author was restricted (`live: 2`), or the account itself is restricted. */
  restricted?: boolean
  /** The hide's reason, read from its label; null when unknown. */
  reasonText?: string | null
  /** The moderator who hid it, as a handle ("@alice"); null while unknown. */
  moderatorName?: string | null
  now?: number
}

/**
 * The label a hidden or restricted item carries where it is shown (to its
 * moderators, and to everyone on an archival build): "Hidden · Spam · by
 * @alice · 2h ago", and "Restricted account" for an author's lane-2 post.
 * Each part only when known. Empty when there is nothing to label.
 */
export function moderationLabelLines({ marks, restricted = false, reasonText = null, moderatorName = null, now = Date.now() }: ModerationLabelInput): string[] {
  const lines: string[] = []
  if (marks && isHidden(marks)) {
    const parts = [hiddenLead(marks.mod === 2, Boolean(reasonText || moderatorName))]
    if (reasonText) parts.push(reasonText)
    if (moderatorName) parts.push(`by ${moderatorName}`)
    if (typeof marks.moderatedAt === 'number') parts.push(relativeTime(marks.moderatedAt, now))
    lines.push(parts.join(' · '))
  }
  if (restricted) lines.push(RESTRICTED_LINE)
  return lines
}

/** The first part of a hide's line. Never a bare label number: with neither reason nor moderator, "Hidden by moderators". */
function hiddenLead(legalHold: boolean, hasDetail: boolean): string {
  if (legalHold) return 'Hidden for legal reasons'
  return hasDetail ? 'Hidden' : 'Hidden by moderators'
}

/**
 * What someone who is not a moderator sees in place of a hidden post or reply
 * they opened by link: calm, no content, never "removed" or "deleted".
 */
export function hiddenStubText(noun: string, reasonText: string | null, legalHold = false): string {
  if (legalHold) return `This ${noun} is hidden by moderators for legal reasons.`
  return reasonText
    ? `This ${noun} is hidden by moderators for ${reasonInSentence(reasonText)}.`
    : `This ${noun} is hidden by moderators.`
}
