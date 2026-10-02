import type { FeedTab } from '@engine/api/feed';
import { router, Stack, useIsFocused, useNavigation } from 'expo-router';
import type { BottomTabNavigationProp } from 'expo-router/tabs';
import { useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { UserGroupIcon } from 'react-native-heroicons/outline';
import { useReducedMotion } from 'react-native-reanimated';

import { useEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { lastIdentity, useCapabilities, useSession, type SessionStatus } from '~/data/session';
import { useEngineStatus } from '~/engine/hooks';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { ComposeFab } from '~/ui/ComposeFab';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { useColors } from '~/ui/tokens';

import { FeedControls, OfflineBanner } from './FeedControls';
import { FeedPage, type FeedPageHandle } from './FeedPage';
import { HomeHeader } from './HomeHeader';
import { accountKey, useHomePrefs, type FeedSort } from './home-prefs';
import { pinOwnPost } from './own-posts';
import { useAppActive, useOffline } from './use-app-active';

const PAGES: readonly FeedTab[] = ['forYou', 'following'];

/** How long For You waits for the session restore with the engine up before reading signed out. */
export const RESTORE_WAIT_MS = 20_000;

/**
 * True once the engine has been up for `RESTORE_WAIT_MS` with the session
 * still unknown: the restore gave up (its retries are spent) or hangs, and
 * For You should not show skeletons forever.
 */
function useRestoreStalled(status: SessionStatus): boolean {
  const { state } = useEngineStatus();
  const waiting = status === 'unknown' && (state === 'ready' || state === 'degraded');
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => setStalled(true), RESTORE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  // The session never goes back to unknown, so once it is known the stall is over for good.
  return waiting && stalled;
}

/** AUTH-02 / UX_SPEC §5.2: the Following tab signed out. */
function FollowingSignedOut() {
  const c = useColors();
  return (
    <View className="flex-1 items-center px-6 py-16" testID="following-signed-out">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
        <UserGroupIcon size={32} color={c.textSecondary} />
      </View>
      <Text variant="title" tone="emphasis" accessibilityRole="header" className="mb-2 text-center">
        See posts from people you follow
      </Text>
      <Text tone="secondary" className="mb-6 max-w-sm text-center">
        Log in to view your personalized following feed and see updates from accounts you care about.
      </Text>
      <Button label="Sign in" onPress={() => router.push('/sign-in')} testID="following-sign-in" />
    </View>
  );
}

/**
 * Home (UX_SPEC §4.8, PRD FEED-01 – FEED-11): For You and Following as
 * swipeable pages, each with its own list and scroll position; Recent / Top
 * where the contract ranks likes; the tab and sort remembered per account.
 */
export function HomeScreen() {
  const { status, identityId } = useSession();
  // Before the engine restores the session, whoever was signed in last time (PRD G-2).
  const viewer = status === 'unknown' ? lastIdentity() : identityId;
  const [prefs, setPrefs] = useHomePrefs(accountKey(viewer));
  const capabilities = useCapabilities();
  const offline = useOffline();
  const appActive = useAppActive();
  const focused = useIsFocused();
  const reduceMotion = useReducedMotion();
  const restoreStalled = useRestoreStalled(status);

  const { tab } = prefs;
  const sort: FeedSort = prefs.sort === 'top' && capabilities?.rankings ? 'top' : 'recent';
  // Following's Top merges per-author rankings, which have no window on the dev cut (web hides it there too).
  const windowed = sort === 'top' && Boolean(capabilities?.windowedRankings);
  const windowFor = (page: FeedTab) => (windowed && page === 'forYou' ? prefs.window : 'all');

  // Pages mount on first visit (or the first swipe toward them) and then keep their scroll position.
  const [visited, setVisited] = useState<ReadonlySet<FeedTab>>(() => new Set([tab]));
  const visit = (pages: readonly FeedTab[]) =>
    setVisited((current) => (pages.every((p) => current.has(p)) ? current : new Set([...current, ...pages])));
  // The tab can also change under the pager (an account switch restores that account's tab).
  if (!visited.has(tab)) visit([tab]);

  const pager = useRef<ScrollView>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const tabIndex = PAGES.indexOf(tab);
  useEffect(() => {
    if (pageWidth > 0) pager.current?.scrollTo({ x: tabIndex * pageWidth, animated: !reduceMotion });
  }, [tabIndex, pageWidth, reduceMotion]);

  const selectTab = (next: FeedTab) => {
    visit([next]);
    if (next !== tab) setPrefs({ tab: next });
  };
  const onPagerSettled = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0) return;
    const next = PAGES[Math.round(e.nativeEvent.contentOffset.x / pageWidth)];
    if (next) selectTab(next);
  };

  const pages = useRef<Partial<Record<FeedTab, FeedPageHandle | null>>>({});

  // Re-tapping Home at its root scrolls to the top, showing pending new posts (UX_SPEC §3.1).
  const navigation = useNavigation();
  useEffect(() => {
    const tabs = navigation.getParent<BottomTabNavigationProp<Record<string, undefined>>>();
    if (!tabs) return undefined;
    return tabs.addListener('tabPress', () => {
      if (navigation.isFocused()) pages.current[tab]?.scrollToTopOrShowNew();
    });
  }, [navigation, tab]);

  // The viewer's new post goes on top of For You at once (PRD PD-3); the data layer refetches the feeds.
  useEngineEvent('content.created', ({ kind, post }) => {
    if (kind === 'post') pinOwnPost(post.id);
  });

  // For You was read signed out while the restore stalled: a late session (even the same account) brings the viewer's marks.
  const readBeforeSession = useRef(false);
  useEffect(() => {
    if (restoreStalled) {
      readBeforeSession.current = true;
    } else if (status !== 'unknown' && readBeforeSession.current) {
      readBeforeSession.current = false;
      queryClient.invalidateQueries({ queryKey: queryKeys.feed.all }).catch(() => undefined);
    }
  }, [restoreStalled, status]);

  const signedIn = status === 'signed-in';
  const live = focused && appActive;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Home', headerShown: false }} />
      <HomeHeader />
      {offline ? <OfflineBanner /> : null}
      <FeedControls
        tab={tab}
        onTab={selectTab}
        sort={sort}
        onSort={(next) => setPrefs({ sort: next })}
        window={prefs.window}
        onWindow={(next) => setPrefs({ window: next })}
        showSort={Boolean(capabilities?.rankings)}
        showWindow={windowed && tab === 'forYou'}
      />
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onLayout={(e: LayoutChangeEvent) => setPageWidth(e.nativeEvent.layout.width)}
        onScrollBeginDrag={() => visit(PAGES)}
        onMomentumScrollEnd={onPagerSettled}
        contentOffset={{ x: tabIndex * pageWidth, y: 0 }}
        className="flex-1"
        testID="home-pager"
      >
        {PAGES.map((page) => (
          <View
            key={page}
            style={{ width: pageWidth }}
            className="flex-1"
            // The page swiped off screen stays mounted (for its scroll position) but out of the screen reader's way.
            accessibilityElementsHidden={page !== tab}
            importantForAccessibility={page === tab ? 'auto' : 'no-hide-descendants'}
          >
            {!visited.has(page) || pageWidth === 0 ? null : page === 'following' && !viewer ? (
              <FollowingSignedOut />
            ) : (
              <FeedPage
                // Another sort or window is another list: it starts at the top, paging afresh.
                key={`${sort}:${windowFor(page)}`}
                ref={(handle) => {
                  pages.current[page] = handle;
                }}
                tab={page}
                sort={sort}
                window={windowFor(page)}
                // Following needs the session; For You waits for it too, so the first page carries the viewer's marks.
                readable={page === 'following' ? signedIn : status !== 'unknown' || restoreStalled}
                live={live && page === tab}
                offline={offline}
              />
            )}
          </View>
        ))}
      </ScrollView>
      <ComposeFab />
    </Screen>
  );
}
