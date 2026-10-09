import { useNetInfo } from '@react-native-community/netinfo';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { SignalSlashIcon } from 'react-native-heroicons/outline';

import { isTemporaryReadFailure } from '~/data/read-error';
import { cn } from '~/lib-allowlist';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/** UX_SPEC §5.12, `lib/error-utils.ts`. */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
export const NETWORK_MESSAGE = 'Network error. Please check your connection and try again.';
export const OFFLINE_MESSAGE = "You're offline. Connect to the internet and try again.";

/**
 * The categorized copy for a failed read (PRD G-11): the unavailability copy
 * for `isTemporaryReadFailure`, which also decides NET-03's retry.
 * Undefined when there is nothing specific to say: the error state then
 * shows only "Something went wrong".
 */
export function readErrorMessage(error: unknown, offline = false): string | undefined {
  if (offline) return OFFLINE_MESSAGE;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'NETWORK') return NETWORK_MESSAGE;
  return isTemporaryReadFailure(error) ? UNAVAILABLE_MESSAGE : undefined;
}

/** A search that failed (D-006): never "No results", which would say no one matched. */
export const searchFailedTitle = (what?: string) => (what ? `Couldn't search ${what} right now` : "Couldn't search right now");

/** Why, as `readErrorMessage` says it for a read; a neutral retry for any other failure. */
export const searchFailedMessage = (error: unknown, offline: boolean) =>
  readErrorMessage(error, offline) ?? 'Try again in a moment.';

/** True when the OS reports no connectivity (PRD G-1); unknown counts as online. */
export function useOffline(): boolean {
  return useNetInfo().isConnected === false;
}

/** UX_SPEC §2.18: pushes the content down, never overlays it. */
export function OfflineBanner({ message = "You're offline. Showing saved results." }: { message?: string }) {
  const c = useColors();
  return (
    <View
      accessibilityRole="alert"
      testID="offline-banner"
      className={cn('min-h-9 flex-row items-center justify-center gap-2 px-4 py-2', tw.offlineBg)}
    >
      <SignalSlashIcon size={16} color={c.textPrimary} />
      <Text variant="subhead">{message}</Text>
    </View>
  );
}

/** A centered spinner with its copy ("Loading trending hashtags…"). */
export function LoadingRow({ label, testID }: { label: string; testID?: string }) {
  return (
    <View className="items-center justify-center gap-4 p-8" testID={testID} accessibilityLiveRegion="polite">
      <Spinner size="md" />
      <Text variant="subhead" tone="secondary" className="text-center">
        {label}
      </Text>
    </View>
  );
}

/** A small section header ("People", "Top creators by likes received"), with an optional trailing control. */
export function SectionHeader({ title, children, testID }: { title: string; children?: ReactNode; testID?: string }) {
  return (
    <View
      className={cn('min-h-11 flex-row items-center justify-between gap-2 border-b px-4 py-2', tw.border, tw.bgSubtle)}
      testID={testID}
    >
      <Text variant="subheadStrong" tone="secondary" accessibilityRole="header" className="flex-1">
        {title}
      </Text>
      {children}
    </View>
  );
}
