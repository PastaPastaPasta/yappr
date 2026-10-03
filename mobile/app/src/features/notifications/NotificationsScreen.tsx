import { FlashList } from '@shopify/flash-list';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, View } from 'react-native';
import { BellIcon, CheckIcon, Cog6ToothIcon } from 'react-native-heroicons/outline';

import { config } from '~/config';
import { queryKeys } from '~/data/keys';
import { lastIdentity, useSession } from '~/data/session';
import { engineSupervisor } from '~/engine';
import { EngineBanner } from '~/engine/EngineBanner';
import { useEngineStatus } from '~/engine/hooks';
import { SignedOutEmptyState } from '~/features/auth/SignedOutPlaceholder';
import { useOffline } from '~/features/home/use-app-active';
import { openExternal, openPost, openUser } from '~/features/post/post-navigation';
import { useSettings } from '~/features/settings/settings-data';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { RowSkeleton, SkeletonGroup } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { FilterChips } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import {
  destinationOf,
  emptyCopy,
  groupNotifications,
  parseFilter,
  snippetOf,
  visibleFilters,
  type MobileFilter,
  type NotificationRowModel,
} from './notification-model';
import { NotificationRow } from './NotificationRow';
import {
  markAllNotificationsRead,
  markNotificationsRead,
  pollNotifications,
  useNotificationBadge,
  useNotificationList,
} from './notifications-data';
import { readErrorMessage, UNAVAILABLE_MESSAGE } from './read-error';

/** UX_SPEC §5.8 (NOTIF-07): reply and quote sources are 3.5-day windows on the dev contract. */
export const WINDOWED_FOOTER = 'Older replies and quotes may not appear here.';
const OFFLINE_MESSAGE = "You're offline";
const REFRESH_FAILED = "Couldn't refresh notifications. Try again.";

function Loading() {
  return (
    <SkeletonGroup label="Loading notifications…" testID="notifications-loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <RowSkeleton key={i} />
      ))}
      <Text variant="subhead" tone="secondary" className="p-6 text-center">
        Loading notifications…
      </Text>
    </SkeletonGroup>
  );
}

function HeaderActions({ canMarkAll }: { canMarkAll: boolean }) {
  // A shared route: it opens on this tab's stack, so Back returns here (UX_SPEC §3.2).
  const openSettings = () => router.push('/settings/notifications');
  const markAll = () => {
    markAllNotificationsRead().catch(() => undefined);
  };
  return (
    <View className="flex-row items-center gap-1">
      {canMarkAll ? (
        Platform.OS === 'ios' ? (
          <Pressable
            accessibilityRole="button"
            onPress={markAll}
            hitSlop={8}
            className="px-2 active:opacity-60"
            testID="notifications-mark-all"
          >
            <Text variant="subhead" tone="link">
              Mark all as read
            </Text>
          </Pressable>
        ) : (
          <IconButton
            icon={CheckIcon}
            accessibilityLabel="Mark all as read"
            // Android's tooltip for an icon-only button.
            onLongPress={() => toast('Mark all as read')}
            onPress={markAll}
            testID="notifications-mark-all"
          />
        )
      ) : null}
      <IconButton
        icon={Cog6ToothIcon}
        accessibilityLabel="Notification settings"
        onLongPress={Platform.OS === 'android' ? () => toast('Notification settings') : undefined}
        onPress={openSettings}
        testID="notifications-settings"
      />
    </View>
  );
}

/**
 * The Notifications tab (UX_SPEC §4.18, PRD NOTIF-01 – NOTIF-09): filter
 * chips, the list with pull to refresh and paging, mark all as read, and
 * the signed-out placeholder.
 */
export function NotificationsScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [chosen, setChosen] = useState<MobileFilter>(() => parseFilter(params.filter));
  // The tab stays mounted: a later `?filter=` link changes the filter too (set during render, as React advises).
  const [linkedFilter, setLinkedFilter] = useState(params.filter);
  if (params.filter !== linkedFilter) {
    setLinkedFilter(params.filter);
    if (params.filter !== undefined) setChosen(parseFilter(params.filter));
  }
  const { status, identityId } = useSession();
  // Before the engine restores the session, whoever was signed in last time counts (PRD G-2).
  const signedIn = status === 'signed-in' || (status === 'unknown' && lastIdentity() !== null);
  const viewerId = identityId ?? (status === 'unknown' ? lastIdentity() : null);
  const { state: engineState } = useEngineStatus();
  const offline = useOffline();

  const settings = useSettings();
  const toggles = settings.data?.notificationSettings;
  const sensitiveMode = settings.data?.sensitiveContentMode;
  const filters = visibleFilters(toggles);
  // A filter whose type was just turned off falls back to All (NOTIF-02).
  const filter = filters.some((f) => f.value === chosen) ? chosen : 'all';

  const list = useNotificationList(filter, signedIn);
  const rows = useMemo(() => groupNotifications(list.items), [list.items]);
  const badge = useNotificationBadge((s) => s.unread);
  const canMarkAll = signedIn && (badge > 0 || rows.some((row) => row.unreadIds.length > 0));

  const onRowPress = useCallback((row: NotificationRowModel) => {
    markNotificationsRead(row.unreadIds);
    const destination = destinationOf(row);
    if (!destination) return;
    if (destination.kind === 'post') openPost(destination.id);
    else if (destination.kind === 'user') openUser(destination.id);
    else openExternal(`https://yap.pr${config.webBasePath}${destination.path}`);
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const { refetch } = list;
  const onRefresh = () => {
    if (offline) {
      toast(OFFLINE_MESSAGE);
      return;
    }
    setRefreshing(true);
    // A poll that changed the lists has refetched them already; a failed one rejects (the toast below).
    pollNotifications(viewerId)
      .then((refetched) => (refetched ? undefined : refetch()))
      .then(() => {
        if (queryClient.getQueryState(queryKeys.notifications(filter))?.status === 'error') {
          toast.error(REFRESH_FAILED);
        }
      })
      .catch(() => toast.error(REFRESH_FAILED))
      .finally(() => setRefreshing(false));
  };

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const loadMore = () => {
    fetchNextPage().catch(() => undefined);
  };
  const onEndReached = () => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) loadMore();
  };

  const header = (
    <Stack.Screen
      options={{
        title: 'Notifications',
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerShadowVisible: false,
        headerRight: signedIn ? () => <HeaderActions canMarkAll={canMarkAll} /> : undefined,
      }}
    />
  );

  let empty;
  if (!signedIn) {
    empty = <SignedOutEmptyState kind="notifications" />;
  } else if (list.data === undefined && (engineState === 'failed' || engineState === 'unsupported')) {
    empty = (
      <ErrorState
        message={UNAVAILABLE_MESSAGE}
        onRetry={() => {
          engineSupervisor.restart('Try again (Notifications)');
          refetch().catch(() => undefined);
        }}
        testID="notifications-engine-down"
      />
    );
  } else if (list.isError && list.data === undefined) {
    empty = (
      <ErrorState
        message={readErrorMessage(list.error)}
        onRetry={() => {
          refetch().catch(() => undefined);
        }}
        testID="notifications-error"
      />
    );
  } else if (list.isPending) {
    empty = <Loading />;
  } else {
    empty = (
      <EmptyState icon={BellIcon} title="No notifications yet" description={emptyCopy(filter)} testID="notifications-empty" />
    );
  }

  let footer = null;
  if (rows.length > 0) {
    if (isFetchingNextPage) {
      footer = (
        <View className="items-center p-6">
          <Spinner size="sm" testID="notifications-next-page" />
        </View>
      );
    } else if (hasNextPage && isFetchNextPageError) {
      footer = (
        <View className="items-center p-6">
          <Button label="Load More" size="sm" onPress={loadMore} testID="notifications-load-more" />
        </View>
      );
    } else if (!hasNextPage && config.network === 'devnet') {
      footer = (
        <Text variant="subhead" tone="secondary" className="p-6 text-center" testID="notifications-windowed">
          {WINDOWED_FOOTER}
        </Text>
      );
    }
  }

  // The list is the screen's first native view from the first render, in every state (signed
  // out, loading, empty, error): iOS only collapses a large title into the bar for a scroll view
  // it finds down the first-subview chain when the screen appears, so a banner in front of the
  // list, or a list swapped in after a placeholder, leaves the title fixed over the rows
  // (D-L4i-004, UX_SPEC §3.4). Banners sit in the list header instead.
  return (
    <>
      {header}
      <FlashList
        data={signedIn ? rows : []}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.preview ? 'post' : 'plain')}
        renderItem={({ item }) => (
          <NotificationRow
            row={item}
            snippet={snippetOf(item.preview, sensitiveMode, viewerId)}
            onPress={onRowPress}
            onActorPress={openUser}
          />
        )}
        extraData={`${sensitiveMode}:${viewerId}`}
        ListHeaderComponent={
          signedIn ? (
            <>
              <EngineBanner />
              <FilterChips options={filters} value={filter} onChange={setChosen} testID="notifications-filters" />
            </>
          ) : null
        }
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={onEndReached}
        onEndReachedThreshold={1.5}
        // New notifications land on top and should show there. FlashList's default keeps the old
        // first row in place, and its autoscroll-to-top scrolls under the iOS large title.
        maintainVisibleContentPosition={{ disabled: true }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          signedIn ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.accent}
              colors={[c.accent]}
              progressBackgroundColor={c.bg}
            />
          ) : undefined
        }
        style={{ backgroundColor: c.bg }}
        // `notifications-list` only once there is a list to show (the e2e flows rely on it).
        testID={signedIn ? 'notifications-list' : 'notifications-placeholder'}
      />
    </>
  );
}
