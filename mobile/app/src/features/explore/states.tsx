import { useNetInfo } from '@react-native-community/netinfo';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { SignalSlashIcon } from 'react-native-heroicons/outline';

import { isTemporaryReadFailure } from '~/data/read-error';
import { cn } from '~/lib-allowlist';
import { PostSkeleton, RowSkeleton, Skeleton, SkeletonGroup } from '~/ui/Skeleton';
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

/** Rows of post skeletons, about a screen of them: the list loads in place, without a jump. */
export function PostListSkeleton({ label, testID }: { label: string; testID?: string }) {
  return (
    <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite" testID={testID}>
      {[0, 1, 2, 3].map((i) => (
        <PostSkeleton key={i} />
      ))}
    </View>
  );
}

/** A trending tag row's skeleton (`TagRow`): the rank, the tag and its count. */
function TagSkeleton() {
  return (
    <SkeletonGroup className="min-h-16 flex-row items-center gap-3 px-4 py-3">
      <View className="w-6 items-end">
        <Skeleton width={12} />
      </View>
      <View className="flex-1 gap-2">
        <Skeleton height={16} width="40%" />
        <Skeleton width="20%" />
      </View>
    </SkeletonGroup>
  );
}

/** Trending tags: rows shaped like `TagRow`. */
export function TagListSkeleton({ label, testID }: { label: string; testID?: string }) {
  return (
    <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite" testID={testID}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <TagSkeleton key={i} />
      ))}
    </View>
  );
}

/** Ranked people: the section header, then user rows. */
export function UserListSkeleton({ label, testID }: { label: string; testID?: string }) {
  return (
    <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite" testID={testID}>
      <View className={cn('min-h-11 justify-center border-b px-4 py-2', tw.border, tw.bgSubtle)}>
        <Skeleton width={180} />
      </View>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <RowSkeleton key={i} />
      ))}
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
