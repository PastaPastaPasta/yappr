import type { OwnReportDTO, PostDTO } from '@engine/api';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  CheckCircleIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  FlagIcon,
  NoSymbolIcon,
} from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { NO_READ_RETRY } from '~/data/read-retry';
import { useCapabilities, useSession } from '~/data/session';
import { runWrite, useWrite, useWriteTicket, writeTicketOf } from '~/data/writes';
import { postWebUrl } from '~/features/post/post-navigation';
import { targetOf } from '~/features/post/post-writes';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { handleOf } from '~/ui/handle';
import { RadioGroup } from '~/ui/RadioGroup';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { tw, useColors } from '~/ui/tokens';

import { useAuthorBlocked } from './block-state';
import { findCachedPost } from './cached';
import { copy, type ReportNoun } from './copy';
import {
  LEGACY_REASON_MAX,
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  reportIsValid,
  reportReasonsUpTo,
  reportReasonLabel,
  reportStatusLabel,
} from './report-reasons';
import {
  announceReportSent,
  emailReport,
  rememberReportTicket,
  rememberWithdrawTicket,
  reportSheetOpen,
  reportWrite,
  useReportTicketId,
  useWithdrawTicketId,
  watchReportSheet,
  withdrawalUnsettled,
  withdrawReportWrite,
} from './report-actions';
import { SheetBody, SheetHeading, SheetLoading, SheetMessage, closeSheet, signInAction } from './SafetySheet';

/** The picker's options for reasons up to `max` (the contract's ceiling; every reason by email). */
const reasonOptions = (max?: number) =>
  reportReasonsUpTo(max).map((reason) => ({
    value: String(reason.code),
    title: reason.label,
    description: reason.hint,
  }));

const shortDate = (date: Date) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "Spam or scam" reads "spam or scam" mid-sentence. */
const midSentence = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** How long a "reports are open" answer holds: it changes only when a moderation team is seated. */
const REPORTS_OPEN_STALE_MS = 10 * 60_000;

/**
 * Report a post or reply (PRD SAFE-04, SAFE-05; UX_SPEC §4.39), from its
 * menu. Where the contract takes reports, the form shows at once and the
 * viewer's existing report is read beside it (found, the sheet shows it
 * instead). Where it doesn't (testnet), or before a moderation team is
 * seated where the contract waits for one, the same reasons go to the Yappr
 * team by email instead, decided before the form.
 */
export function ReportScreen() {
  const { postId = '', kind } = useLocalSearchParams<{ postId?: string; kind?: string }>();
  const noun: ReportNoun = kind === 'reply' ? 'reply' : 'post';
  const capabilities = useCapabilities();
  const { status, identityId: viewerId } = useSession();
  const seed = useMemo(() => findCachedPost(postId), [postId]);
  const takesReports = capabilities?.reports === true;
  const signedIn = status === 'signed-in';
  const post = useEngineQuery(queryKeys.post.detail(postId), (api) => api.posts.get(postId), {
    enabled: postId !== '' && takesReports && signedIn,
    placeholderData: seed,
  });
  // A failed read never holds the form back, nor swaps it later: a refusal after it still offers email.
  const open = useEngineQuery(queryKeys.reportsOpen, (api) => api.safety.reportsOpen(), {
    enabled: takesReports && signedIn,
    staleTime: REPORTS_OPEN_STALE_MS,
    retry: false,
    meta: NO_READ_RETRY,
  });
  const header = <Stack.Screen options={{ title: copy.report.title(noun) }} />;
  // A list showed it: a read that finds nothing may be a transient miss, and filing a report on a
  // post that is really gone fails with its own message (TARGET_GONE).
  const shown = post.data ?? seed;
  const postUrl = postWebUrl(shown ?? postId);

  if (!capabilities || status === 'unknown') return <SheetLoading testID="report-loading" />;
  if (!takesReports) {
    return (
      <>
        {header}
        <EmailReport postId={postId} postUrl={postUrl} />
      </>
    );
  }
  if (!signedIn) {
    return (
      <>
        {header}
        <SheetMessage title={copy.report.signIn} icon={FlagIcon} action={signInAction} testID="report-signed-out" />
      </>
    );
  }
  if (post.isPending || open.isPending) return <SheetLoading testID="report-loading" />;
  if (post.isError && !shown) {
    return (
      <>
        {header}
        <SheetMessage
          title={copy.report.loadFailed(noun)}
          icon={ExclamationTriangleIcon}
          action={{ label: 'Try again', onPress: () => post.refetch().catch(() => undefined) }}
          testID="report-error"
        />
      </>
    );
  }
  if (!shown) {
    return (
      <>
        {header}
        <SheetMessage title={copy.report.gone(noun)} icon={FlagIcon} testID="report-gone" />
      </>
    );
  }
  if (shown.author.id === viewerId) {
    return (
      <>
        {header}
        <SheetMessage title={copy.report.own(noun)} icon={FlagIcon} testID="report-own" />
      </>
    );
  }
  return (
    <>
      {header}
      {open.data === false ? (
        <EmailReport postId={shown.id} postUrl={postUrl} />
      ) : (
        <ReportFlow post={shown} noun={noun} postUrl={postUrl} />
      )}
    </>
  );
}

/** "What is wrong with it?" with the reasons, and the details field. */
function ReasonFields({
  reason,
  onReason,
  note,
  onNote,
  busy = false,
  maxReason,
}: {
  reason: number | null;
  onReason: (reason: number) => void;
  note: string;
  onNote: (note: string) => void;
  busy?: boolean;
  /** The highest reason the contract accepts (`capabilities.reportReasonMax`); omitted by email, which takes any. */
  maxReason?: number;
}) {
  const options = useMemo(() => reasonOptions(maxReason), [maxReason]);
  return (
    <>
      <View className="gap-2">
        <Text variant="subheadStrong" accessibilityRole="header">
          {copy.report.question}
        </Text>
        <View className={cn('overflow-hidden rounded-xl border', tw.border)} pointerEvents={busy ? 'none' : 'auto'}>
          <RadioGroup
            options={options}
            value={reason === null ? '' : String(reason)}
            onChange={(value) => onReason(Number(value))}
            accessibilityLabel={copy.report.question}
            testID="report-reason"
          />
        </View>
      </View>
      <TextField
        label={copy.report.details(reason === OTHER_REASON_CODE)}
        placeholder={copy.report.placeholder}
        value={note}
        onChangeText={onNote}
        maxLength={REPORT_NOTE_MAX_LENGTH}
        alwaysCount
        editable={!busy}
        multiline
        testID="report-note"
      />
    </>
  );
}

function ReportFlow({ post, noun, postUrl }: { post: PostDTO; noun: ReportNoun; postUrl: string }) {
  const target = useMemo(() => targetOf(post), [post]);
  // v13 accepts reason 9 (sexual content involving minors); earlier contracts stop at 8.
  const maxReason = useCapabilities()?.reportReasonMax ?? LEGACY_REASON_MAX;
  // Read beside the form, never in front of it: a failed read still lets the report go (a second one is
  // refused as DUPLICATE, which then shows the report).
  const own = useEngineQuery(queryKeys.post.ownReport(post.id), (api) => api.safety.ownReport(target), {
    staleTime: 0,
  });
  const write = useWrite(reportWrite);
  // A report an earlier sheet for this post sent (dismissed, then reopened): followed while it is on its
  // way or may have landed, to its outcome, instead of offering the form for a second, paid report.
  const earlier = useWriteTicket(useReportTicketId(post.id));
  const [followed, setFollowed] = useState<string | null>(null);
  const earlierUnsettled =
    earlier?.state === 'pending' || (earlier?.state === 'unconfirmed' && !earlier.retryable);
  if (earlier && earlierUnsettled && followed !== earlier.id) setFollowed(earlier.id);
  const current = write.ticket ?? (earlier && earlier.id === followed ? earlier : null);
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState('');
  // From the tap until the engine answers: a second tap would queue a second, paid report.
  const [sending, setSending] = useState(false);
  const outcome = current?.state ?? 'idle';
  const code = current?.error?.code;
  // A withdrawal sent from any sheet that may yet land: it already said "Report withdrawn".
  const withdrawal = useWriteTicket(useWithdrawTicketId(post.id));
  // The report being withdrawn, from the confirmation until the sheet closes: it stays on screen while the
  // cache drops it (optimistic), and a second tap would send a second delete.
  const [withdrawing, setWithdrawing] = useState<OwnReportDTO | null>(null);

  // The sheet says how it went while it is open.
  useEffect(() => watchReportSheet(post.id), [post.id]);

  // Dismissed while the report is on its way: nothing on screen will say it went, and a report the engine
  // took counts as sent (only one proven not to have landed says otherwise).
  const onItsWay = outcome === 'pending' ? (current?.id ?? null) : null;
  useEffect(() => {
    if (!onItsWay) return undefined;
    return () => {
      if (writeTicketOf(onItsWay)?.state === 'pending') announceReportSent(onItsWay);
    };
  }, [onItsWay]);

  // A duplicate means a report exists after all: show it.
  const refetchOwn = own.refetch;
  useEffect(() => {
    if (code === 'DUPLICATE') refetchOwn().catch(() => undefined);
  }, [code, refetchOwn]);

  const askWithdraw = (report: OwnReportDTO) => {
    if (withdrawing) return;
    confirmAlert({
      title: copy.report.withdrawTitle,
      message: copy.report.withdrawBody,
      confirmText: copy.report.withdrawConfirm,
      destructive: true,
    })
      .then(async (confirmed) => {
        if (!confirmed) return;
        setWithdrawing(report);
        const result = await runWrite(withdrawReportWrite, { target, reportId: report.id });
        if (result.status === 'refused') {
          setWithdrawing(null);
          return;
        }
        // Optimistic, like a toggle: only a withdrawal proven not to have landed says otherwise.
        if (result.status === 'submitted') rememberWithdrawTicket(post.id, result.ticket.id);
        toast.success(copy.toast.reportWithdrawn);
        closeSheet();
      })
      .catch(() => setWithdrawing(null));
  };

  if (withdrawing) return <ExistingReport report={withdrawing} withdrawing onWithdraw={askWithdraw} />;
  if (withdrawalUnsettled(withdrawal)) {
    return <SheetMessage title={copy.toast.reportWithdrawn} icon={CheckCircleIcon} testID="report-withdrawn" />;
  }
  // Sent: confirmed, or not confirmed yet with no check proving it absent (a DAPI wait timeout, often).
  if (outcome === 'confirmed' || (outcome === 'unconfirmed' && current?.retryable !== true)) {
    return <ReportSent author={post.author} />;
  }
  if (outcome === 'failed' && code === 'MODERATION_NOT_SEATED') {
    return (
      <EmailReport
        postId={post.id}
        postUrl={postUrl}
        refusal={copy.report.notSeated}
        initialReason={reason}
        initialNote={note}
      />
    );
  }
  if (own.data) {
    return <ExistingReport report={own.data} withdrawing={false} onWithdraw={askWithdraw} />;
  }

  const busy = sending || outcome === 'pending';
  const valid = reportIsValid(reason, note, maxReason);
  const submit = () => {
    if (reason === null || busy) return;
    const trimmed = note.trim();
    setSending(true);
    write
      .send({ target, reason, note: trimmed || undefined, noun })
      .then((result) => {
        if (result.status !== 'submitted') return;
        rememberReportTicket(post.id, result.ticket.id);
        // Closed before the engine took it: nothing on screen says it went.
        if (!reportSheetOpen(post.id)) announceReportSent(result.ticket.id);
      })
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  return (
    <SheetBody testID="report-sheet">
      <SheetHeading icon={FlagIcon} body={copy.report.disclosure} />
      <ReasonFields reason={reason} onReason={setReason} note={note} onNote={setNote} busy={busy} maxReason={maxReason} />
      <Button
        label={busy ? copy.report.busy : copy.report.submit(noun)}
        size="block"
        loading={busy}
        disabled={!valid}
        onPress={submit}
        testID="report-submit"
      />
      <Button label={copy.cancel} variant="ghost" size="block" onPress={closeSheet} disabled={busy} testID="report-cancel" />
    </SheetBody>
  );
}

/**
 * The viewer's report: when, why and where it stands ("Under review", or how
 * the moderators resolved it), the note, when reports close, and "Withdraw
 * report" (PRD SAFE-04) with "Done".
 */
function ExistingReport({
  report,
  withdrawing,
  onWithdraw,
}: {
  report: OwnReportDTO;
  withdrawing: boolean;
  onWithdraw: (report: OwnReportDTO) => void;
}) {
  const summary = copy.report.existing(
    shortDate(report.createdAt),
    midSentence(reportReasonLabel(report.reason)),
    report.status === null ? null : reportStatusLabel(report.status),
  );
  return (
    <SheetBody testID="report-existing">
      <SheetHeading icon={FlagIcon} body={summary} />
      {report.note ? (
        <View className={cn('rounded-lg border p-3', tw.border, tw.bgSubtle)}>
          <Text variant="subhead">{report.note}</Text>
        </View>
      ) : null}
      {report.resolution ? (
        <View
          className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950"
          testID="report-resolution"
        >
          <Text variant="subhead">{report.resolution}</Text>
        </View>
      ) : null}
      <Text variant="subhead" tone="secondary" testID="report-expiry">
        {copy.report.expiry}
      </Text>
      <Button
        label={withdrawing ? copy.report.withdrawing : copy.report.withdraw}
        variant="outline"
        size="block"
        loading={withdrawing}
        onPress={() => onWithdraw(report)}
        testID="report-withdraw"
      />
      <Button label={copy.report.done} size="block" onPress={closeSheet} disabled={withdrawing} testID="report-done" />
    </SheetBody>
  );
}

/** After the report: thanks, and "Also block @x" (PRD SAFE-04, P1). */
function ReportSent({ author }: { author: PostDTO['author'] }) {
  const c = useColors();
  const handle = handleOf(author);
  const alreadyBlocked = useAuthorBlocked(author.id);
  const alsoBlock = () => {
    router.replace({ pathname: '/block/[userId]', params: { userId: author.id } });
  };
  return (
    <SheetBody testID="report-sent">
      <SheetHeading icon={CheckCircleIcon} iconColor={c.repost} title={copy.report.sentTitle} body={copy.report.sentBody} />
      {alreadyBlocked ? null : (
        <Button
          label={copy.report.alsoBlock(handle)}
          variant="outline"
          size="block"
          icon={NoSymbolIcon}
          onPress={alsoBlock}
          testID="report-also-block"
        />
      )}
      <Button label={copy.report.done} size="block" onPress={closeSheet} testID="report-done" />
    </SheetBody>
  );
}

/**
 * Report by email (PRD SAFE-05): the only way where the contract takes no
 * reports, and where it waits for a moderation team that isn't seated. The
 * same reasons as the form; the mail opens with them and the post's link.
 * After a refusal (`refusal`), it keeps what was already chosen.
 */
function EmailReport({
  postId,
  postUrl,
  refusal,
  initialReason = null,
  initialNote = '',
}: {
  postId: string;
  postUrl: string;
  refusal?: string;
  initialReason?: number | null;
  initialNote?: string;
}) {
  const c = useColors();
  const [reason, setReason] = useState<number | null>(initialReason);
  const [note, setNote] = useState(initialNote);
  const send = () => {
    if (reason === null) return;
    emailReport(postId, postUrl, { reason: reportReasonLabel(reason), note })
      .then(closeSheet)
      .catch(() => undefined);
  };
  return (
    <SheetBody testID="report-email">
      {refusal ? (
        <View className={cn('flex-row gap-2 rounded-lg p-3', tw.offlineBg)} testID="report-refused">
          <ExclamationTriangleIcon size={20} color={c.warning} />
          <Text variant="subhead" tone="warning" className="flex-1">
            {refusal}
          </Text>
        </View>
      ) : null}
      <SheetHeading icon={EnvelopeIcon} title={copy.report.emailTitle} body={copy.report.emailBody} />
      <ReasonFields reason={reason} onReason={setReason} note={note} onNote={setNote} />
      <Button
        label={copy.report.email}
        size="block"
        icon={EnvelopeIcon}
        disabled={!reportIsValid(reason, note)}
        onPress={send}
        testID="report-email-send"
      />
      <Button label={copy.cancel} variant="ghost" size="block" onPress={closeSheet} testID="report-cancel" />
    </SheetBody>
  );
}
