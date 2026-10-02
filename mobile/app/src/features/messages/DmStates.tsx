import type { DmRecoveryDTO } from '@engine/api';
import { router } from 'expo-router';
import { View } from 'react-native';
import { EnvelopeIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { EmptyState } from '~/ui/EmptyState';
import { RowSkeleton, SkeletonGroup } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/** UX_SPEC §4.37: the Messages tab signed out. */
export function DmSignedOut() {
  return (
    <EmptyState
      icon={EnvelopeIcon}
      title="Sign in to read your messages"
      description="Private 1-on-1 and group conversations."
      action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
      testID="messages-signed-out"
    />
  );
}

/** PRD DM-02: no encryption key for this account on the device. */
export function DmLocked({ onUnlock }: { onUnlock: () => void }) {
  return (
    <EmptyState
      icon={LockClosedIcon}
      title="Unlock your messages"
      description="Messages are encrypted with your encryption key. Enter it on this device to read and send them."
      action={{ label: 'Enter encryption key', onPress: onUnlock }}
      testID="messages-locked"
    />
  );
}

/** UX_SPEC §2.15 conversation skeleton: a 40 circle, two bars and a time bar. */
export function InboxSkeleton() {
  return (
    <SkeletonGroup label="Loading conversations…" testID="messages-loading">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <RowSkeleton key={i} withTime />
      ))}
    </SkeletonGroup>
  );
}

const RECOVERY_STEP: Record<DmRecoveryDTO['phase'], string> = {
  invites: 'Finding conversations people started with you',
  'contacts-recent': 'Checking recent chats with people you follow',
  groups: 'Finding your groups',
  'contacts-older': 'Checking older chats with people you follow',
};

/** PRD DM-01: "Restoring your messages" with the current step, while a new device recovers. */
export function RestoringBanner({ recovery }: { recovery: DmRecoveryDTO }) {
  const step = RECOVERY_STEP[recovery.phase];
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Restoring your messages. ${step}`}
      className={cn('mx-4 mb-2 flex-row items-center gap-3 rounded-xl px-3 py-2.5', tw.bgMuted)}
      testID="messages-restoring"
    >
      <Spinner size="sm" />
      <View className="flex-1">
        <Text variant="subheadStrong">Restoring your messages</Text>
        <Text variant="caption" tone="secondary">
          {step}
          {recovery.found > 0 ? ` · ${recovery.found} found` : ''}
        </Text>
      </View>
    </View>
  );
}

/** A thin notice above the list (offline, a failed background check). */
export function InboxNotice({ text, testID }: { text: string; testID?: string }) {
  return (
    <View className={cn('mx-4 mb-2 rounded-xl px-3 py-2', tw.offlineBg)} testID={testID}>
      <Text variant="caption" tone="warning">
        {text}
      </Text>
    </View>
  );
}
