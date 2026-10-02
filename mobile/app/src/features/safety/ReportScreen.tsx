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
import { useCapabilities, useSession } from '~/data/session';
import { useWrite, useWriteTicket } from '~/data/writes';
import { postWebUrl } from '~/features/post/post-navigation';
import { targetOf } from '~/features/post/post-writes';
import { Button } from '~/ui/Button';
import { handleOf } from '~/ui/handle';
import { RadioGroup } from '~/ui/RadioGroup';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { tw, useColors } from '~/ui/tokens';

import { useAuthorBlocked } from './block-state';
import { findCachedPost } from './cached';
import { copy, type ReportNoun } from './copy';
import {
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  reportIsValid,
  reportReasonLabel,
  reportStatusLabel,
} from './report-reasons';
import {
  emailReport,
  rememberReportTicket,
  reportWrite,
  useReportTicketId,
  watchReportSheet,
} from './report-actions';
import { SheetBody, SheetHeading, SheetLoading, SheetMessage, closeSheet, signInAction } from './SafetySheet';

const REASON_OPTIONS = REPORT_REASONS.map((reason) => ({
  value: String(reason.code),
  title: reason.label,
  description: reason.hint,
}));

const shortDate = (date: Date) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Report a post or reply (PRD SAFE-04, SAFE-05; UX_SPEC §4.39), from its
 * menu. Where the contract takes reports, the sheet first checks for the
 * viewer's existing report (one per target, and paid, so a failed check
 * never offers a second), then shows the form, and stays open until the
 * network has the report. Where it doesn't (testnet), it offers an email to
 * the Yappr team instead.
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
        <EmailReport postId={postId} postUrl={postUrl} noun={noun} />
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
  if (post.isPending) return <SheetLoading testID="report-loading" />;
  if (post.isError && !shown) {
    return (
      <>
        {header}
        <SheetMessage
          title={copy.report.checkFailed(noun)}
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
      <ReportFlow post={shown} noun={noun} postUrl={postUrl} resolves={capabilities.reportsResolved} />
    </>
  );
}

function ReportFlow({
  post,
  noun,
  postUrl,
  resolves,
}: {
  post: PostDTO;
  noun: ReportNoun;
  postUrl: string;
  resolves: boolean;
}) {
  const target = useMemo(() => targetOf(post), [post]);
  const own = useEngineQuery(queryKeys.post.ownReport(post.id), (api) => api.safety.ownReport(target), {
    staleTime: 0,
  });
  const write = useWrite(reportWrite);
  // A report an earlier sheet for this post sent (dismissed, then reopened): followed from when it is
  // seen on its way, to its outcome, instead of offering the form for a second report.
  const earlier = useWriteTicket(useReportTicketId(post.id));
  const [followed, setFollowed] = useState<string | null>(null);
  if (earlier?.state === 'pending' && followed !== earlier.id) setFollowed(earlier.id);
  const current = write.ticket ?? (earlier && earlier.id === followed ? earlier : null);
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState('');
  // From the tap until the engine answers: a second tap would queue a second, paid report.
  const [sending, setSending] = useState(false);
  const outcome = current?.state ?? 'idle';
  const code = current?.error?.code;

  // The sheet says how it went while it is open; the write toasts only once it is gone.
  useEffect(() => watchReportSheet(post.id), [post.id]);

  // A duplicate means a report exists after all: show it.
  const refetchOwn = own.refetch;
  useEffect(() => {
    if (code === 'DUPLICATE') refetchOwn().catch(() => undefined);
  }, [code, refetchOwn]);

  if (outcome === 'confirmed' || outcome === 'unconfirmed') {
    return <ReportSent author={post.author} unconfirmed={outcome === 'unconfirmed'} />;
  }
  if (outcome === 'failed' && code === 'MODERATION_NOT_SEATED') {
    return <EmailReport postId={post.id} postUrl={postUrl} noun={noun} refusal={copy.report.notSeated} />;
  }
  // A cached "no report" is re-checked before the form shows: one may have been filed since.
  if (own.isPending || (own.isFetching && own.data === null)) {
    return <SheetLoading label={copy.report.checking} testID="report-checking" />;
  }
  if (own.isError) {
    return (
      <SheetMessage
        title={copy.report.checkFailed(noun)}
        icon={ExclamationTriangleIcon}
        action={{ label: 'Try again', onPress: () => own.refetch().catch(() => undefined) }}
        testID="report-check-failed"
      />
    );
  }
  if (own.data) return <ExistingReport report={own.data} noun={noun} resolves={resolves} />;

  const busy = sending || outcome === 'pending';
  const valid = reportIsValid(reason, note);
  const submit = () => {
    if (reason === null || busy) return;
    const trimmed = note.trim();
    setSending(true);
    write
      .send({ target, reason, note: trimmed || undefined, noun })
      .then((result) => {
        if (result.status === 'submitted') rememberReportTicket(post.id, result.ticket.id);
      })
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  return (
    <SheetBody testID="report-sheet">
      <SheetHeading icon={FlagIcon} body={copy.report.disclosure(noun, resolves)} />
      <View className="gap-2">
        <Text variant="subheadStrong" accessibilityRole="header">
          {copy.report.question}
        </Text>
        <View className={cn('overflow-hidden rounded-xl border', tw.border)} pointerEvents={busy ? 'none' : 'auto'}>
          <RadioGroup
            options={REASON_OPTIONS}
            value={reason === null ? '' : String(reason)}
            onChange={(value) => setReason(Number(value))}
            accessibilityLabel={copy.report.question}
            testID="report-reason"
          />
        </View>
      </View>
      <TextField
        label={copy.report.details(reason === OTHER_REASON_CODE)}
        placeholder={copy.report.placeholder}
        value={note}
        onChangeText={setNote}
        maxLength={REPORT_NOTE_MAX_LENGTH}
        alwaysCount
        editable={!busy}
        multiline
        testID="report-note"
      />
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

/** "You reported this post": what, when, and how the moderators resolved it (v10). */
function ExistingReport({ report, noun, resolves }: { report: OwnReportDTO; noun: ReportNoun; resolves: boolean }) {
  const c = useColors();
  const summary = `${copy.report.existing(shortDate(report.createdAt), reportReasonLabel(report.reason))} ${
    resolves ? (report.status === null ? copy.report.pending(noun) : '') : copy.report.pendingUnresolved(noun)
  }`.trim();
  return (
    <SheetBody testID="report-existing">
      <SheetHeading icon={FlagIcon} title={copy.report.existingTitle(noun)} body={summary} />
      {report.note ? (
        <View className={cn('rounded-lg border p-3', tw.border, tw.bgSubtle)}>
          <Text variant="subhead">{report.note}</Text>
        </View>
      ) : null}
      {report.status !== null ? (
        <View
          className="flex-row gap-2 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950"
          testID="report-resolution"
        >
          <CheckCircleIcon size={20} color={c.repost} />
          <View className="flex-1 gap-1">
            <Text variant="subhead">
              {copy.report.resolved(
                reportStatusLabel(report.status),
                report.moderatedAt ? shortDate(report.moderatedAt) : null,
              )}
            </Text>
            {report.resolution ? <Text variant="subhead">{report.resolution}</Text> : null}
          </View>
        </View>
      ) : null}
      <Button label={copy.report.done} size="block" onPress={closeSheet} testID="report-done" />
    </SheetBody>
  );
}

/** After the report: thanks, and "Also block @x?" (PRD SAFE-04, P1). */
function ReportSent({ author, unconfirmed }: { author: PostDTO['author']; unconfirmed: boolean }) {
  const c = useColors();
  const handle = handleOf(author);
  const alreadyBlocked = useAuthorBlocked(author.id);
  const alsoBlock = () => {
    router.replace({ pathname: '/block/[userId]', params: { userId: author.id } });
  };
  return (
    <SheetBody testID="report-sent">
      <SheetHeading
        icon={CheckCircleIcon}
        iconColor={c.repost}
        title={copy.report.sentTitle}
        body={unconfirmed ? copy.toast.reportUnconfirmed : copy.report.sentBody}
      />
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

/** Report by email (PRD SAFE-05): the only way where the contract takes no reports, and the fallback before moderators are seated. */
function EmailReport({
  postId,
  postUrl,
  noun,
  refusal,
}: {
  postId: string;
  postUrl: string;
  noun: ReportNoun;
  refusal?: string;
}) {
  const c = useColors();
  const send = () => {
    emailReport(postId, postUrl)
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
      <SheetHeading icon={EnvelopeIcon} title={copy.report.emailTitle} body={copy.report.emailBody(noun)} />
      <Text variant="subhead" tone="secondary" selectable numberOfLines={2}>
        {postUrl}
      </Text>
      <Button label={copy.report.email} size="block" icon={EnvelopeIcon} onPress={send} testID="report-email-send" />
      <Button label={copy.cancel} variant="ghost" size="block" onPress={closeSheet} testID="report-cancel" />
    </SheetBody>
  );
}

