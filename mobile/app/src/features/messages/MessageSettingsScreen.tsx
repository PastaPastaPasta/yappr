import type { DmRetention, DmStatusDTO } from '@engine/api';
import { router, Stack, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { handleOf } from '~/ui/handle';
import { ErrorState } from '~/ui/EmptyState';
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
  { value: 'never', title: 'Never' },
  { value: '30d', title: 'After 30 days' },
  { value: '90d', title: 'After 90 days' },
  { value: '1y', title: 'After 1 year' },
];

/**
 * UX_SPEC §5.8 `dm.retention.footer` (#14): what deleting gives back, and the
 * caveat that must stay: it does not make messages private (never called
 * "disappearing messages", which would promise that).
 */
export const RETENTION_FOOTER =
  "Deleting old sent messages refunds most of their storage fee. It doesn't make them private: people you messaged keep their copies, and Dash Platform keeps a history.";

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
      <View className="gap-1 px-4 py-3" testID="dm-blocked-empty">
        <Text variant="body">No blocked accounts</Text>
        <Text variant="subhead" tone="secondary">
          Messages and group invites from people you block are ignored.
        </Text>
      </View>
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
 * Back to the screen underneath (Settings or the inbox: this screen is pushed
 * on the current tab), or to the inbox when there is nothing to go back to
 * (a link that opened this screen on its own). Never a jump to the Messages
 * tab from another tab's stack, which would leave this screen on top of that
 * stack (the stuck-tab bug).
 *
 * `navigation.canGoBack()` is read fresh inside the effect rather than from a
 * render-time `isRoot` comparison: that comparison looked at the nav state's
 * top-level `routes[0]`, which does not reflect the current tab's own stack
 * under a nested navigator and could leave the redirect armed after a real
 * back target existed. The ref keeps the one-shot effect from firing twice:
 * once for the mount, and again if `navigation` changes identity before the
 * pop or replace completes.
 */
function LeaveForInbox() {
  const navigation = useNavigation();
  const left = useRef(false);
  useEffect(() => {
    if (left.current || !navigation.isFocused()) return;
    left.current = true;
    if (navigation.canGoBack()) navigation.goBack();
    else router.replace('/messages');
  }, [navigation]);
  return null;
}

/**
 * Message settings (UX_SPEC §4.23, PRD DM-12): v5 "Delete old sent messages"
 * and the people blocked in Messages. Legacy (testnet) has none (DM-11): it
 * goes back, or to the inbox; its read receipts are in Settings (SET-04).
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

  // Nothing to set on legacy messages (#23).
  if (backend === 'legacy') return <LeaveForInbox />;

  if (status.isError && !status.data) {
    return (
      <Screen>
        {header}
        <ErrorState message={readErrorMessage(status.error)} onRetry={() => refreshDm()} testID="dm-settings-error" />
      </Screen>
    );
  }

  // The engine runs but its saved state never loaded: say so, not two loading placeholders.
  if (status.data?.error && !status.data.ready && !status.data.locked) {
    return (
      <Screen>
        {header}
        <ErrorState message="Couldn't load your message settings. Check your connection and try again." onRetry={() => refreshDm()} testID="dm-settings-error" />
      </Screen>
    );
  }

  const retention = status.data?.retention ?? null;
  return (
    <Screen scroll>
      {header}
      <SectionHeader title="Delete old sent messages" />
      {retention ? (
        <>
          <RadioGroup
            options={RETENTION_OPTIONS}
            value={retention}
            onChange={(value) => {
              setRetention(value).catch(() => undefined);
            }}
            accessibilityLabel="Delete old sent messages"
            testID="dm-retention"
          />
          <Text variant="subhead" tone="secondary" className="px-4 pt-3" testID="dm-retention-body">
            {RETENTION_FOOTER}
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
      {/* Not before the saved state loads: an empty list would read as "Nobody". Locked, it never does. */}
      {status.data?.ready ? (
        <BlockedList ids={status.data.blocked} />
      ) : status.data?.locked ? (
        <Text variant="subhead" tone="secondary" className="px-4 py-3" testID="dm-blocked-locked">
          Unlock your messages to see who you blocked.
        </Text>
      ) : (
        <RowSkeleton />
      )}
      <View className="h-10" />
    </Screen>
  );
}
