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
import { lastIdentity, useCapabilities, useSession } from '~/data/session';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { ComposeFab } from '~/ui/ComposeFab';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { useColors } from '~/ui/tokens';

import { prependToFirstPage, type FeedData } from './feed-data';
import { FeedControls, OfflineBanner } from './FeedControls';
import { FeedPage, type FeedPageHandle } from './FeedPage';
import { HomeHeader } from './HomeHeader';
import { accountKey, useHomePrefs, type FeedSort } from './home-prefs';
import { pinOwnPost } from './own-posts';
import { useAppActive, useOffline } from './use-app-active';

const PAGES: readonly FeedTab[] = ['forYou', 'following'];

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

  const { tab } = prefs;
  const sort: FeedSort = prefs.sort === 'top' && capabilities?.rankings ? 'top' : 'recent';
  // Following's Top merges per-author rankings, which have no window on the dev cut (web hides it there too).
  const windowed = sort === 'top' && Boolean(capabilities?.windowedRankings);
  const windowFor = (page: FeedTab) => (windowed && page === 'forYou' ? prefs.window : 'all');

  // Pages mount on first visit (or the first swipe toward them) and then keep their scroll position.
  const [visited, setVisited] = useState<ReadonlySet<FeedTab>>(() => new Set([tab]));
  const visit = (pages: readonly FeedTab[]) =>
    setVisited((current) => (pages.every((p) => current.has(p)) ? current : new Set([...current, ...pages])));

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

  // The viewer's new post goes on top of For You at once (PRD PD-3).
  useEngineEvent('content.created', ({ kind, post }) => {
    if (kind !== 'post') return;
    pinOwnPost(post.id);
    queryClient.setQueryData<FeedData>(queryKeys.feed.home({ tab: 'forYou' }), (data) =>
      prependToFirstPage(data, [post]),
    );
  });

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
          <View key={page} style={{ width: pageWidth }} className="flex-1">
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
                readable={page === 'following' ? signedIn : status !== 'unknown'}
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
