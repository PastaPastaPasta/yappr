import type { StoreReportTarget } from '@engine/api';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { useWrite } from '~/data/writes';
import { OTHER_REASON_CODE, REPORT_NOTE_MAX_LENGTH, REPORT_STATUSES, reportReasonsUpTo } from '~/features/safety/report-reasons';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { RadioGroup } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';

import { Loading } from './parts';

import { storeReportWrite, withdrawStoreReportWrite } from './store-writes';

const DOC_TYPES: readonly StoreReportTarget['docType'][] = ['store', 'storeItem', 'storeReview', 'itemReview'];

/** "Report" under a store, product or review (web `ContractReportButton`): not on the viewer's own. */
export function ReportLink({ target, noun }: { target: StoreReportTarget; noun: string }) {
  const viewerId = useViewerId();
  if (viewerId === target.ownerId) return null;
  return (
    <Pressable
      accessibilityRole="button"
      testID="store-report-link"
      onPress={() => requireAuth(() => router.push({ pathname: '/store-report', params: { ...target, noun } }))}
      style={{ minHeight: 44, justifyContent: 'center' }}
      className="mt-6"
    >
      <Text tone="secondary">Report this {noun}</Text>
    </Pressable>
  );
}

/**
 * Report a store, product or review to the storefront's moderators (web's
 * contract report dialog). Reports are public and go to the
 * community-elected moderators, not to Yappr.
 */
export function StoreReportScreen() {
  const params = useLocalSearchParams<{ docType: string; targetId: string; ownerId: string; noun?: string }>();
  const docType = DOC_TYPES.find((type) => type === params.docType);
  const target: StoreReportTarget | null = docType && params.targetId && params.ownerId ? { docType, targetId: params.targetId, ownerId: params.ownerId } : null;
  const noun = params.noun ?? 'listing';
  const own = useEngineQuery(queryKeys.store.ownReport(params.targetId ?? ''), (api) => (target ? api.store.ownReport(target) : Promise.resolve(null)), { enabled: target !== null });
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const report = useWrite(storeReportWrite);
  const withdraw = useWrite(withdrawStoreReportWrite);
  const code = reason === '' ? null : Number(reason);
  const needsNote = code === OTHER_REASON_CODE && !note.trim();

  if (!target) return <Screen><ErrorState title="Nothing to report" message="This link is incomplete." /></Screen>;

  const submit = () => {
    if (code === null || needsNote) return;
    report.run({ target, reason: code, note: note.trim() }).then((ticket) => { if (ticket) router.back(); }).catch(() => undefined);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: `Report ${noun}` }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <Text tone="secondary">
          Reports go to the community&apos;s moderators and are public.
        </Text>
        {own.isPending ? <Loading /> : own.isError ? (
          <ErrorState message="Couldn't check your reports." onRetry={() => own.refetch()} retrying={own.isRetrying} />
        ) : own.data ? (
          <View className="mt-4 gap-3" testID="store-report-own">
            <Text variant="bodyStrong">You reported this {noun}.</Text>
            {own.data.note ? <Text>{own.data.note}</Text> : null}
            <Text tone="secondary">
              {own.data.status === null ? 'Waiting for moderator review.' : `Resolved: ${REPORT_STATUSES.find((s) => s.code === own.data?.status)?.label ?? 'Resolved'}.`}
            </Text>
            {own.data.status === null ? (
              <Button variant="outline" label="Withdraw report" loading={withdraw.status === 'pending'} onPress={() => own.data && withdraw.run({ reportId: own.data.id, targetId: target.targetId })} />
            ) : null}
          </View>
        ) : (
          <View className="mt-4 gap-4">
            <RadioGroup
              accessibilityLabel="Why are you reporting this?"
              options={reportReasonsUpTo().map((r) => ({ value: String(r.code), title: r.label, description: r.hint }))}
              value={reason}
              onChange={setReason}
              testID="store-report-reasons"
            />
            <TextField label={code === OTHER_REASON_CODE ? 'Details (required)' : 'Details (optional)'} value={note} onChangeText={setNote} multiline maxLength={REPORT_NOTE_MAX_LENGTH} testID="store-report-note" />
            <Button size="block" label="Send report" testID="store-report-send" disabled={code === null || needsNote} loading={report.status === 'pending'} onPress={submit} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
