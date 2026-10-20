import type { BlogOwnReportDTO, BlogReportDocType, BlogReportTargetDTO } from '@engine/api';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { NO_READ_RETRY } from '~/data/read-retry';
import { useSession } from '~/data/session';
import { useWrite } from '~/data/writes';
import {
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  reportIsValid,
  reportReasonLabel,
  reportReasonsUpTo,
} from '~/features/safety/report-reasons';
import { Button } from '~/ui/Button';
import { RadioGroup } from '~/ui/RadioGroup';
import { Sheet } from '~/ui/Sheet';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { tw } from '~/ui/tokens';

import { reportBlogWrite, withdrawBlogReportWrite } from './blog-writes';

const NOUNS: Record<BlogReportDocType, string> = { blog: 'blog', blogPost: 'post', blogComment: 'comment' };

const EXPLANATION =
  'Reports are public. Anyone can see that you reported this, and why.';

/** How long a "reports are open" answer holds: it changes only when moderators are seated. */
const REPORTS_OPEN_STALE_MS = 10 * 60_000;

const REASON_OPTIONS = reportReasonsUpTo().map((reason) => ({
  value: String(reason.code),
  title: reason.label,
  description: reason.hint,
}));

function ExistingReport({
  report,
  noun,
  busy,
  onWithdraw,
}: {
  report: BlogOwnReportDTO;
  noun: string;
  busy: boolean;
  onWithdraw: () => void;
}) {
  return (
    <View className="gap-3" testID="blog-report-existing">
      <Text variant="bodyStrong">{`You reported this ${noun}`}</Text>
      <Text variant="body">{reportReasonLabel(report.reason)}</Text>
      {report.note ? (
        <View className={cn('rounded-lg border p-3', tw.border, tw.bgSubtle)}>
          <Text variant="subhead">{report.note}</Text>
        </View>
      ) : null}
      <Text variant="subhead" tone="secondary">
        {report.status === null ? 'Waiting for moderator review.' : `Resolved: ${report.status}.`}
      </Text>
      {report.resolution ? (
        <View className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950">
          <Text variant="subhead">{report.resolution}</Text>
        </View>
      ) : null}
      {report.status === null ? (
        <Button
          label="Withdraw report"
          variant="outline"
          size="block"
          loading={busy}
          onPress={onWithdraw}
          testID="blog-report-withdraw"
        />
      ) : null}
    </View>
  );
}

/** The reasons and the note. Keyed by target, so a draft survives a dismissed sheet but not another target. */
function ReportForm({
  noun,
  busy,
  onSend,
}: {
  noun: string;
  busy: boolean;
  onSend: (reason: number, note: string) => void;
}) {
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const valid = useMemo(() => reportIsValid(reason, note), [reason, note]);
  return (
    <View className="gap-4" testID="blog-report-form">
      <Text variant="subhead" tone="secondary">
        {EXPLANATION}
      </Text>
      <View className="gap-2">
        <Text variant="subheadStrong" accessibilityRole="header">
          What is wrong with it?
        </Text>
        <View className={cn('overflow-hidden rounded-xl border', tw.border)} pointerEvents={busy ? 'none' : 'auto'}>
          <RadioGroup
            options={REASON_OPTIONS}
            value={reason === null ? '' : String(reason)}
            onChange={(value) => setReason(Number(value))}
            accessibilityLabel="What is wrong with it?"
            testID="blog-report-reason"
          />
        </View>
      </View>
      <TextField
        label={reason === OTHER_REASON_CODE ? 'Details (required)' : 'Details (optional)'}
        placeholder="Anything the moderators should know"
        value={note}
        onChangeText={setNote}
        maxLength={REPORT_NOTE_MAX_LENGTH}
        multiline
        editable={!busy}
        testID="blog-report-note"
      />
      <Button
        label={`Report ${noun}`}
        size="block"
        loading={busy}
        disabled={!valid}
        onPress={() => {
          if (reason !== null) onSend(reason, note.trim());
        }}
        testID="blog-report-submit"
      />
    </View>
  );
}

/**
 * Report a blog, post or comment to the blog contract's moderators. Shows the
 * viewer's own report instead when there is one (with Withdraw while it is
 * open), and nothing to fill in until moderators are elected.
 */
export function BlogReportSheet({
  target,
  open,
  onClose,
}: {
  target: BlogReportTargetDTO;
  open: boolean;
  onClose: () => void;
}) {
  const noun = NOUNS[target.docType];
  const { status: sessionStatus } = useSession();
  const signedIn = sessionStatus === 'signed-in';
  const enabled = open && signedIn;
  const reportsOpen = useEngineQuery(queryKeys.blog.reportsOpen, (api) => api.blogs.reportsOpen(), {
    enabled,
    staleTime: REPORTS_OPEN_STALE_MS,
    meta: NO_READ_RETRY,
  });
  const own = useEngineQuery(
    queryKeys.blog.ownReport(target.docType, target.targetId),
    (api) => api.blogs.ownReport(target),
    { enabled, staleTime: 0, meta: NO_READ_RETRY },
  );

  const report = useWrite(reportBlogWrite);
  const withdraw = useWrite(withdrawBlogReportWrite);
  // From the tap until the engine answers with a ticket: a second tap would send a second report.
  const [sending, setSending] = useState(false);
  const busy = sending || report.status === 'pending' || withdraw.status === 'pending';

  // A report the engine took counts as sent, confirmed or not (only a write proved absent says
  // otherwise, through the write's own failure toast). Each ticket is handled once, so reopening
  // the sheet later does not close it again.
  const handled = useRef<string | null>(null);
  const reportTicket = report.ticket;
  const reportState = report.status;
  const withdrawTicket = withdraw.ticket;
  const withdrawState = withdraw.status;
  useEffect(() => {
    const done = (ticket: typeof reportTicket, state: typeof reportState) =>
      ticket !== null && handled.current !== ticket.id && (state === 'confirmed' || (state === 'unconfirmed' && ticket.retryable !== true));
    if (reportTicket && done(reportTicket, reportState)) {
      handled.current = reportTicket.id;
      toast.success('Report sent');
      onClose();
    } else if (withdrawTicket && done(withdrawTicket, withdrawState)) {
      handled.current = withdrawTicket.id;
      if (withdrawState === 'confirmed') toast.success('Report withdrawn');
      onClose();
    }
  }, [reportTicket, reportState, withdrawTicket, withdrawState, onClose]);

  const send = (reason: number, note: string) => {
    if (busy) return;
    setSending(true);
    report
      .send({ target, reason, note })
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  const ownReportId = own.data?.id ?? '';
  const sendWithdraw = () => {
    if (busy || ownReportId === '') return;
    setSending(true);
    withdraw
      .send({ reportId: ownReportId, target })
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  let body;
  if (!signedIn) {
    body = (
      <View className="gap-3" testID="blog-report-signed-out">
        <Text variant="body">{`Sign in to report this ${noun}.`}</Text>
        <Button
          label="Sign in"
          size="block"
          onPress={() => {
            onClose();
            router.push('/sign-in');
          }}
          testID="blog-report-sign-in"
        />
      </View>
    );
  } else if (reportsOpen.isPending || own.isPending) {
    // Both reads fail alike below; a failed one is no longer pending.
    body = (
      <View className="items-center p-6" testID="blog-report-loading">
        <Spinner />
      </View>
    );
  } else if (reportsOpen.isError || own.isError) {
    body = (
      <View className="gap-3" testID="blog-report-error">
        <Text variant="body">{"Couldn't check your reports. Try again."}</Text>
        <Button
          label="Try again"
          variant="outline"
          size="block"
          onPress={() => {
            Promise.all([reportsOpen.refetch(), own.refetch()]).catch(() => undefined);
          }}
          testID="blog-report-retry"
        />
      </View>
    );
  } else if (own.data) {
    body = <ExistingReport report={own.data} noun={noun} busy={busy} onWithdraw={sendWithdraw} />;
  } else if (reportsOpen.data === false) {
    body = (
      <Text variant="body" testID="blog-report-closed">
        Reporting opens once moderators are elected.
      </Text>
    );
  } else {
    body = <ReportForm key={target.targetId} noun={noun} busy={busy} onSend={send} />;
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Report ${noun}`} dismissible={!busy} scrollable testID="blog-report-sheet">
      {body}
    </Sheet>
  );
}
