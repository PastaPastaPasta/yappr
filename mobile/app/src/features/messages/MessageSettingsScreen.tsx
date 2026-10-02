import type { DmRetention, DmStatusDTO } from '@engine/api';
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { Cog6ToothIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { handleOf } from '~/ui/handle';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { RadioGroup, type RadioOption } from '~/ui/RadioGroup';
import { Screen } from '~/ui/Screen';
import { RowSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { tw } from '~/ui/tokens';
import { queryClient } from '~/state/query-client';

import { setBlockedInMessages } from './dm-actions';
import { readErrorMessage, refreshDm, useDmBackend, useDmStatus, useDmViewer, usePeople } from './dm-data';
import { DmSignedOut } from './DmStates';

const RETENTION_OPTIONS: readonly RadioOption<DmRetention>[] = [
  { value: 'never', title: 'Never (keep paying for storage)' },
  { value: '30d', title: 'After 30 days' },
  { value: '90d', title: 'After 90 days' },
  { value: '1y', title: 'After 1 year' },
];

const PERIOD: Record<Exclude<DmRetention, 'never'>, string> = { '30d': '30 days', '90d': '90 days', '1y': '1 year' };

/** UX_SPEC §5.8 `dm.retention.body` / `bodyPeriod` (web). */
export function retentionExplanation(retention: DmRetention): string {
  const rest =
    "This saves money. It does not make old messages private: copies remain in the blockchain's history, and the people you messaged keep what they have.";
  if (retention === 'never') {
    return `Your sent messages stay on Dash Platform and you keep paying for their storage. Choose a period below to delete them once they are that old and get most of their storage fee back. ${rest}`;
  }
  return `Delete your sent messages from Dash Platform after ${PERIOD[retention]} and get most of their storage fee back. ${rest}`;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Text variant="captionStrong" tone="secondary" accessibilityRole="header" className="px-4 pb-2 pt-6 uppercase">
      {title}
    </Text>
  );
}

async function setRetention(retention: DmRetention): Promise<void> {
  const previous = queryClient.getQueryData<DmStatusDTO>(queryKeys.dm.status);
  if (previous) queryClient.setQueryData<DmStatusDTO>(queryKeys.dm.status, { ...previous, retention });
  try {
    await engine.api.dm.setRetention(retention);
  } catch (error) {
    appendLog('warn', 'host', `Saving retention failed: ${errorMessage(error)}`);
    if (previous) queryClient.setQueryData(queryKeys.dm.status, previous);
    toast.error("Couldn't save the setting. Try again.");
  }
}

function BlockedList({ ids }: { ids: string[] }) {
  const people = usePeople(ids);
  if (ids.length === 0) {
    return (
      <Text variant="subhead" tone="secondary" className="px-4 py-3" testID="dm-blocked-empty">
        Nobody. Blocked people&apos;s messages and group invitations are ignored.
      </Text>
    );
  }
  return (
    <View>
      {people.isPending ? <RowSkeleton /> : null}
      {ids.map((id, index) => {
        const person = people.byId.get(id);
        const name = person?.displayName ?? `User ${id.slice(-6)}`;
        return (
          <View
            key={id}
            className={cn('min-h-[64px] flex-row items-center gap-3 px-4 py-2', index > 0 && cn('border-t', tw.border))}
            testID={`dm-blocked-${id}`}
          >
            <Avatar avatar={person?.avatar} identityId={id} size="md" />
            <View className="flex-1">
              <Text variant="bodyStrong" numberOfLines={1}>
                {name}
              </Text>
              <Text variant="subhead" tone="secondary" numberOfLines={1}>
                {person ? handleOf(person) : id.slice(0, 12)}
              </Text>
            </View>
            <Button
              label="Unblock"
              variant="outline"
              size="sm"
              accessibilityLabel={`Unblock ${name}`}
              onPress={() => {
                setBlockedInMessages(id, false).catch(() => undefined);
              }}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * Message settings (UX_SPEC §4.23, PRD DM-12): v5 "Reclaim message fees" and
 * the people blocked in Messages. Legacy (testnet) has none (DM-11); its read
 * receipts are in Settings (SET-04).
 */
export function MessageSettingsScreen() {
  const { signedIn } = useDmViewer();
  const backend = useDmBackend();
  const status = useDmStatus(signedIn && backend !== 'legacy');
  const header = <Stack.Screen options={{ title: 'Message settings' }} />;

  if (!signedIn) {
    return (
      <Screen>
        {header}
        <DmSignedOut />
      </Screen>
    );
  }

  if (backend === 'legacy') {
    return (
      <Screen>
        {header}
        <EmptyState icon={Cog6ToothIcon} title="Message settings aren't available on this network" testID="dm-settings-unavailable" />
      </Screen>
    );
  }

  if (status.isError && !status.data) {
    return (
      <Screen>
        {header}
        <ErrorState message={readErrorMessage(status.error)} onRetry={() => refreshDm()} testID="dm-settings-error" />
      </Screen>
    );
  }

  const retention = status.data?.retention ?? null;
  return (
    <Screen scroll>
      {header}
      <SectionHeader title="Reclaim message fees" />
      {retention ? (
        <>
          <RadioGroup
            options={RETENTION_OPTIONS}
            value={retention}
            onChange={(value) => {
              setRetention(value).catch(() => undefined);
            }}
            accessibilityLabel="Reclaim message fees"
            testID="dm-retention"
          />
          <Text variant="subhead" tone="secondary" className="px-4 pt-3" testID="dm-retention-body">
            {retentionExplanation(retention)}
          </Text>
        </>
      ) : status.data?.locked ? (
        <Text variant="subhead" tone="secondary" className="px-4 py-3">
          Unlock your messages to change this setting.
        </Text>
      ) : (
        <View className="items-center py-6" accessible accessibilityLabel="Loading">
          <Spinner size="sm" />
        </View>
      )}
      <SectionHeader title="Blocked" />
      {/* Not before the saved state loads: an empty list would read as "Nobody". */}
      {status.data?.ready ? <BlockedList ids={status.data.blocked} /> : <RowSkeleton />}
      <View className="h-10" />
    </Screen>
  );
}
