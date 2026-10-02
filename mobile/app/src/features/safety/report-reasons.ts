/**
 * Report reasons and resolutions, as `lib/reports.ts` defines them. That
 * module imports the SDK helpers, so it can't come through the lib
 * allowlist; this copy is checked against it by `report-reasons.test.ts`.
 * The codes are stored on chain, so they are frozen with the contract.
 */

export interface ReportReason {
  code: number;
  label: string;
  hint: string;
}

export const REPORT_REASONS: readonly ReportReason[] = [
  { code: 0, label: 'Spam or scam', hint: 'Repetitive, misleading or fraudulent content' },
  { code: 1, label: 'Harassment or bullying', hint: 'Targeting, insulting or intimidating someone' },
  { code: 2, label: 'Hate', hint: 'Attacking people for who they are' },
  { code: 3, label: 'Violence or threats', hint: 'Threatening, inciting or glorifying violence' },
  { code: 4, label: 'Sexual content', hint: 'Explicit sexual content' },
  { code: 5, label: 'Self-harm', hint: 'Encouraging suicide or self-injury' },
  { code: 6, label: 'Illegal goods or activity', hint: 'Selling or promoting something illegal' },
  { code: 7, label: 'Impersonation', hint: 'Pretending to be someone else' },
  { code: 8, label: 'Something else', hint: 'Say what in the details' },
];

/** "Something else": the contract refuses it without a note. */
export const OTHER_REASON_CODE = 8;

/** `report.note` maxLength. */
export const REPORT_NOTE_MAX_LENGTH = 500;

/** How the moderators resolved a report (v10 `report.status`). */
export const REPORT_STATUSES: readonly { code: number; label: string }[] = [
  { code: 1, label: 'No action taken' },
  { code: 2, label: 'Content removed' },
  { code: 3, label: 'Author actioned' },
];

export function reportReasonLabel(code: number): string {
  return REPORT_REASONS.find((reason) => reason.code === code)?.label ?? `Reason ${code}`;
}

export function reportStatusLabel(code: number): string {
  return REPORT_STATUSES.find((status) => status.code === code)?.label ?? `Status ${code}`;
}

/** Whether a report can be filed as given (`reportInputProblem`): a known reason, a note for "something else", at most 500. */
export function reportIsValid(reason: number | null, note: string): boolean {
  if (reason === null || !REPORT_REASONS.some((known) => known.code === reason)) return false;
  const trimmed = note.trim();
  if (reason === OTHER_REASON_CODE && trimmed.length === 0) return false;
  return trimmed.length <= REPORT_NOTE_MAX_LENGTH;
}
