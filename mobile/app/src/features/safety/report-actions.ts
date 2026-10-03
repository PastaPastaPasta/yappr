import type { TargetRef, WriteTicket } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { Linking } from 'react-native';
import { create } from 'zustand';

import { queryKeys } from '~/data/keys';
import type { WriteSpec } from '~/data/writes';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { toast } from '~/ui/toast';

import { copy, SUPPORT_EMAIL, type ReportNoun } from './copy';

export interface ReportVars {
  target: TargetRef;
  reason: number;
  note?: string;
  noun: ReportNoun;
}

/** The write's own words for refusals web names (`reportFailureMessage`), and the unseated moderation team. */
function reportFailureText(ticket: WriteTicket, { noun }: ReportVars): string | null {
  switch (ticket.error?.code) {
    case 'DUPLICATE':
      return `You have already reported this ${noun}.`;
    case 'TARGET_GONE':
      return `This ${noun} has been removed, so there is nothing to report.`;
    case 'MODERATION_NOT_SEATED':
      return copy.report.notSeated;
    default:
      return null;
  }
}

/** Targets whose report sheet is on screen: it says how the report went itself. */
const openSheets = new Map<string, number>();

/** The report sheet for `targetId` is on screen until the returned cleanup runs. */
export function watchReportSheet(targetId: string): () => void {
  openSheets.set(targetId, (openSheets.get(targetId) ?? 0) + 1);
  return () => {
    const left = (openSheets.get(targetId) ?? 1) - 1;
    if (left > 0) openSheets.set(targetId, left);
    else openSheets.delete(targetId);
  };
}

/**
 * The latest report and withdrawal tickets per target, so a sheet reopened
 * while either is on its way (or not confirmed yet) follows it instead of
 * offering the form, or Withdraw, again.
 */
const useReportTickets = create<{
  byTarget: Readonly<Record<string, string>>;
  withdrawals: Readonly<Record<string, string>>;
}>()(() => ({ byTarget: {}, withdrawals: {} }));

export function rememberReportTicket(targetId: string, ticketId: string): void {
  useReportTickets.setState(({ byTarget }) => ({ byTarget: { ...byTarget, [targetId]: ticketId } }));
}

/** The id of the report ticket last submitted for `targetId`, from any sheet. */
export function useReportTicketId(targetId: string): string | null {
  return useReportTickets((s) => s.byTarget[targetId] ?? null);
}

export function rememberWithdrawTicket(targetId: string, ticketId: string): void {
  useReportTickets.setState(({ withdrawals }) => ({ withdrawals: { ...withdrawals, [targetId]: ticketId } }));
}

/** The id of the withdrawal ticket last submitted for `targetId`, from any sheet. */
export function useWithdrawTicketId(targetId: string): string | null {
  return useReportTickets((s) => s.withdrawals[targetId] ?? null);
}

/**
 * Whether a withdrawal may yet land: on its way, or `unconfirmed` with no
 * check proving it absent. Sending another then could only be refused, and
 * charged (a delete of a report already gone).
 */
export function withdrawalUnsettled(ticket: WriteTicket | null): boolean {
  return ticket?.state === 'pending' || (ticket?.state === 'unconfirmed' && !ticket.retryable);
}

/**
 * Report a post or reply (`safety.report`, PRD SAFE-04). The report sheet
 * follows its status and says how it went; the tracker announces a failure,
 * and a confirmation only when the sheet was closed first. Not optimistic:
 * nothing shows a report until it exists. One per target: a report sent
 * while one is on its way is dropped, not queued behind it (a second paid
 * write the engine would refuse as `DUPLICATE`).
 */
export const reportWrite: WriteSpec<ReportVars> = {
  key: ({ target }) => `report:${target.id}`,
  submit: (api, { target, reason, note }) => api.safety.report(target, reason, note),
  intent: () => 'report',
  matches: (ticket, { target }) =>
    ticket.op === 'report' && (ticket.target as { id?: string } | null)?.id === target.id,
  onConfirmed: (_ticket, { target }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.post.ownReport(target.id) }).catch(() => undefined);
    if (!openSheets.has(target.id)) toast.success(copy.toast.reportSent);
  },
  announceUnconfirmed: false,
  failureText: reportFailureText,
  noun: 'report',
  failureMessage: 'Failed to send the report. Please try again.',
};

export interface WithdrawReportVars {
  target: TargetRef;
  /** `OwnReportDTO.id`. */
  reportId: string;
}

/**
 * Withdraw the viewer's report (`safety.withdrawReport`, PRD SAFE-04): the
 * report is deleted, so the sheet that asked closes once it confirms, and
 * "Report withdrawn" shows. Not optimistic. It shares the report's key: one
 * write per target at a time. Not confirmed yet, the open sheet says so
 * itself (with Check again); a closed one leaves it to the toast. A report
 * already gone (`REPORT_GONE`) says so in a neutral toast and the sheet
 * closes, as on web; the viewer's report is read again.
 */
export const withdrawReportWrite: WriteSpec<WithdrawReportVars> = {
  key: ({ target }) => `report:${target.id}`,
  submit: (api, { target, reportId }) => api.safety.withdrawReport(target, reportId),
  intent: () => 'withdraw',
  matches: (ticket, { target }) =>
    ticket.op === 'report.withdraw' && (ticket.target as { id?: string } | null)?.id === target.id,
  onConfirmed: (_ticket, { target }) => {
    queryClient.setQueryData(queryKeys.post.ownReport(target.id), null);
    toast.success(copy.toast.reportWithdrawn);
  },
  announceUnconfirmed: (_ticket, { target }) => !openSheets.has(target.id),
  onFailed: (ticket, { target }) => {
    if (ticket.error?.code !== 'REPORT_GONE') return;
    queryClient.invalidateQueries({ queryKey: queryKeys.post.ownReport(target.id) }).catch(() => undefined);
  },
  failureText: (ticket) => (ticket.error?.code === 'REPORT_GONE' ? copy.toast.reportGone : null),
  failureNeutral: (ticket) => ticket.error?.code === 'REPORT_GONE',
  noun: 'report withdrawal',
  failureMessage: copy.toast.withdrawFailed,
};

/** The mail draft to the Yappr team (PRD SAFE-05, PD-13): subject "Report: post {id}", the link and a "Reason:" line. */
export function reportMailUrl(postId: string, postUrl: string): string {
  const subject = encodeURIComponent(copy.report.emailSubject(postId));
  const body = encodeURIComponent(`${postUrl}\n\nReason: `);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/**
 * Opens the mail composer with the report. With no mail app to take it, the
 * address and the link are copied instead, and a toast says so.
 */
export async function emailReport(postId: string, postUrl: string): Promise<'opened' | 'copied'> {
  try {
    await Linking.openURL(reportMailUrl(postId, postUrl));
    return 'opened';
  } catch (error) {
    appendLog('info', 'host', `No mail app for the report: ${errorMessage(error)}`);
    await Clipboard.setStringAsync(`${SUPPORT_EMAIL}\n${postUrl}`).catch(() => undefined);
    toast(copy.toast.reportCopied);
    return 'copied';
  }
}
