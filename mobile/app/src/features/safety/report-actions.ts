import type { TargetRef, WriteTicket } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { Linking } from 'react-native';

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

/**
 * Report a post or reply (`safety.report`, PRD SAFE-04). The report sheet
 * follows its status and says how it went, so the tracker announces only a
 * failure. Not optimistic: nothing shows a report until it exists.
 */
export const reportWrite: WriteSpec<ReportVars> = {
  key: ({ target }) => `report:${target.id}`,
  submit: (api, { target, reason, note }) => api.safety.report(target, reason, note),
  matches: (ticket, { target }) =>
    ticket.op === 'report' && (ticket.target as { id?: string } | null)?.id === target.id,
  onConfirmed: (_ticket, { target }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.post.ownReport(target.id) }).catch(() => undefined);
  },
  announceUnconfirmed: false,
  failureText: reportFailureText,
  noun: 'report',
  failureMessage: 'Failed to send the report. Please try again.',
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
