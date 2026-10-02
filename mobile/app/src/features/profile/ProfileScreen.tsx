import type { PostDTO, ProfileDTO, ProfileReplyDTO } from '@engine/api';
import type { ProfileTab } from '@engine/api/profiles';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router, Stack, useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { RefreshControl, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import {
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  UserIcon,
} from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { useRequireAuth } from '~/data/require-auth';
import { lastIdentity, useCapabilities, useSession } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { appendLog, errorMessage } from '~/engine/logs';
import { copyText } from '~/features/post/post-navigation';
import { PostItem } from '~/features/post/PostItem';
import { blockWrite, useAuthorBlocked } from '~/features/safety/block-state';
import { copy as safetyCopy } from '~/features/safety/copy';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { ContextMenu, type MenuItem } from '~/ui/ContextMenu';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { Spinner } from '~/ui/Spinner';
import { TopTabs } from '~/ui/Tabs';
import { PostSkeleton } from '~/ui/Skeleton';
import { tw, useColors } from '~/ui/tokens';

import { copyProfileLink, messageUser, shareProfile, toggleFollow } from './profile-actions';
import { initialTab, looksLikeIdentityId, looksLikeName, profileTabs, type ProfileTabSpec } from './profile-format';
import { ProfileHeader, ProfileHeaderSkeleton } from './ProfileHeader';
import { ProfileTopBar, TopBarIcon, useTopBarHeight } from './ProfileTopBar';
import { useNsfwAcknowledged } from './nsfw-ack';
import { UsernameCard } from './UsernameCard';

type ProfileItem = PostDTO | ProfileReplyDTO;

type Row =
  | { kind: 'header' }
  | { kind: 'tabs' }
  | { kind: 'post'; post: ProfileItem }
  | { kind: 'skeleton' }
  | { kind: 'state'; element: ReactElement };

/** The banner shows at least this much below the bar, where the avatar overlaps it. */
const BANNER_BELOW_BAR = 64;
const BANNER_MIN = 150;

const rowKey = (row: Row, index: number) => (row.kind === 'post' ? row.post.id : `${row.kind}-${index}`);
const rowType = (row: Row) => {
  if (row.kind !== 'post') return row.kind;
  if (row.post.bareRepost || row.post.quoted) return 'quote';
  return row.post.media.length > 0 ? 'media' : 'text';
};

/** The handle in "Replying to @x" (the card adds the `@`) for a Replies-tab row, whose parent comes with it. */
const replyingTo = (item: ProfileItem) => {
  const parent = 'parent' in item ? item.parent : undefined;
  return parent ? (parent.author.username ?? parent.author.displayName) : undefined;
};

function ProfileTabList({
  profileId,
  tab,
  spec,
  header,
  tabBar,
  onScroll,
  onRefreshProfile,
  stickOffset,
  startStuck,
  barHeight,
}: {
  profileId: string;
  tab: ProfileTab;
  spec: ProfileTabSpec;
  header: ReactElement;
  tabBar: ReactElement;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onRefreshProfile: () => Promise<unknown>;
  /** The offset at which the tab bar meets the top bar (0 until the header is measured). */
  stickOffset: number;
  /** A tab picked while the tabs were stuck opens with them stuck. */
  startStuck: boolean;
  barHeight: number;
}) {
  const c = useColors();
  const listRef = useRef<FlashListRef<Row>>(null);
  // Room below a short tab (an empty state, a few posts), so the tabs can always reach the
  // top bar: otherwise a stuck start is clamped short and the pinned copy shows twice.
  const [spacer, setSpacer] = useState(0);
  const spacerRef = useRef(0);
  const measured = useRef({ viewport: 0, content: 0 });
  // Held until the user scrolls: content that shrinks (skeleton to posts) clamps the offset,
  // and the next pass puts the tabs back.
  const holdStick = useRef(startStuck);
  const settle = () => {
    const { viewport, content } = measured.current;
    if (viewport <= 0 || content <= 0 || stickOffset <= 0) return;
    const needed = Math.max(0, Math.ceil(viewport + stickOffset - (content - spacerRef.current)));
    if (Math.abs(needed - spacerRef.current) > 1) {
      spacerRef.current = needed;
      setSpacer(needed);
      return;
    }
    if (holdStick.current && content - viewport >= stickOffset - 1) {
      // After this layout pass: scrolling from inside it is clamped to the old content size.
      requestAnimationFrame(() => {
        if (holdStick.current) listRef.current?.scrollToOffset({ offset: stickOffset, animated: false });
      });
    }
  };
  const posts = useEngineInfiniteQuery<ProfileItem>(
    queryKeys.profile.posts(profileId, tab),
    (api, cursor) => api.profiles.posts({ id: profileId, tab, cursor }),
    { persist: true },
  );
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    Promise.all([onRefreshProfile(), posts.refetch()])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  let body: Row[];
  if (posts.items.length > 0) {
    body = posts.items.map((post) => ({ kind: 'post', post }));
  } else if (posts.isError) {
    body = [
      {
        kind: 'state',
        element: (
          <ErrorState
            onRetry={() => {
              posts.refetch().catch(() => undefined);
            }}
            testID="profile-posts-error"
          />
        ),
      },
    ];
  } else if (posts.isPending) {
    body = [{ kind: 'skeleton' }, { kind: 'skeleton' }, { kind: 'skeleton' }];
  } else {
    body = [
      {
        kind: 'state',
        element: <EmptyState title={spec.empty.title} description={spec.empty.description} testID={`profile-empty-${tab}`} />,
      },
    ];
  }

  const more = posts.isFetchingNextPage ? (
    <View className="items-center p-6">
      <Spinner size="sm" />
    </View>
  ) : posts.isFetchNextPageError ? (
    <View className="items-center p-6">
      <Button
        label="Load more posts"
        size="sm"
        onPress={() => {
          posts.fetchNextPage().catch(() => undefined);
        }}
      />
    </View>
  ) : null;
  const footer = (
    <>
      {more}
      {spacer > 0 ? <View style={{ height: spacer }} /> : null}
    </>
  );

  const rows: Row[] = [{ kind: 'header' }, { kind: 'tabs' }, ...body];
  return (
    <FlashList
      ref={listRef}
      data={rows}
      keyExtractor={rowKey}
      getItemType={rowType}
      renderItem={({ item }) => {
        if (item.kind === 'post') return <PostItem post={item.post} replyingTo={replyingTo(item.post)} />;
        if (item.kind === 'header') return header;
        if (item.kind === 'tabs') return tabBar;
        if (item.kind === 'skeleton') return <PostSkeleton />;
        return item.element;
      }}
      ListFooterComponent={footer}
      onEndReached={() => {
        if (posts.hasNextPage && !posts.isFetchingNextPage && !posts.isFetchNextPageError) {
          posts.fetchNextPage().catch(() => undefined);
        }
      }}
      onEndReachedThreshold={1.5}
      onScroll={onScroll}
      onScrollBeginDrag={() => {
        holdStick.current = false;
      }}
      scrollEventThrottle={16}
      onLayout={(event) => {
        measured.current.viewport = event.nativeEvent.layout.height;
        settle();
      }}
      onContentSizeChange={(_width, height) => {
        measured.current.content = height;
        settle();
      }}
      contentInsetAdjustmentBehavior="never"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          progressViewOffset={barHeight}
          tintColor={c.accent}
          colors={[c.accent]}
          progressBackgroundColor={c.bg}
        />
      }
      testID={`profile-list-${tab}`}
    />
  );
}

export interface ProfileScreenProps {
  /** Identity id or DPNS name (`profiles.get` takes either). */
  idOrName: string;
  /** The Profile tab: the viewer's own profile, with the Settings button. */
  ownTab?: boolean;
  /** `?tab=` from a link (`/mentions?user=X` opens Mentions). */
  requestedTab?: string;
}

/**
 * A profile, the viewer's own or anyone's (PRD PROF-01 – PROF-05, PROF-09 –
 * PROF-13; UX_SPEC §4.12): the header, then the Posts / Replies / Top /
 * Mentions tabs, or the blocked notice or the NSFW interstitial in their
 * place.
 */
export function ProfileScreen({ idOrName, ownTab = false, requestedTab }: ProfileScreenProps) {
  const c = useColors();
  const requireAuth = useRequireAuth();
  const { identityId: viewerId, accounts } = useSession();
  const capabilities = useCapabilities();
  const tabs = profileTabs(capabilities);
  const [tab, setTab] = useState<ProfileTab>(() => initialTab(requestedTab, tabs));
  const shownTab = tabs.find((t) => t.value === tab) ?? tabs[0]!;

  const barHeight = useTopBarHeight();
  const bannerHeight = Math.max(BANNER_MIN, barHeight + BANNER_BELOW_BAR);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    // Only the thresholds matter: re-render when one is crossed, not on every frame.
    // Stuck from the exact offset a stuck tab switch opens at, so the next switch stays stuck too.
    const next = y > bannerHeight - barHeight ? (headerHeight > 0 && y >= headerHeight - barHeight - 1 ? 2 : 1) : 0;
    setScrollY((current) => (current === next ? current : next));
  };
  const tabsStuck = scrollY === 2;

  const valid = looksLikeIdentityId(idOrName) || looksLikeName(idOrName);
  const profileQuery = useEngineQuery(
    queryKeys.profile.detail(idOrName),
    (api) => api.profiles.get(idOrName),
    { persist: true, enabled: valid },
  );
  const settings = useEngineQuery(queryKeys.settings, (api) => api.settings.get());
  const profile: ProfileDTO | null | undefined = profileQuery.data;
  const profileId = profile?.id ?? '';
  // The Profile tab is the viewer's own even while the session restores (viewerId still null).
  const isSelf = !!profile && (ownTab || profile.id === viewerId);
  const [nsfwAcknowledged, acknowledgeNsfw] = useNsfwAcknowledged(profileId);

  const name = profile?.displayName ?? '';
  const handle = profile ? handleOf(profile) : '';
  // A block or unblock made on this device counts at once (features/safety); while the session restores, the engine's word.
  const blockedHere = useAuthorBlocked(profile?.id, profile?.viewer?.blocks);
  const blocked = !isSelf && (viewerId ? blockedHere : profile?.viewer?.blocks === true);
  // Blocked only through a followed block list (PROF-11): managed on web, so no Unblock here.
  const blockedByList = blocked && profile?.viewer?.blockedBy === 'list';
  const following = profile?.viewer?.follows === true;
  // Gated until the setting says otherwise (the engine's default is on): not while it loads, nor if it can't be read.
  const bannerGated = !isSelf && !following && settings.data?.gateMediaFromNonFollowed !== false;
  const nsfwGated =
    !!profile?.nsfw && !isSelf && settings.data?.sensitiveContentMode !== 'show' && !nsfwAcknowledged;

  // The banner (or the loading gradient) is under the bar: not for "not found", errors or the NSFW notice.
  const bannerShown = valid && profile !== null && !(profile === undefined && profileQuery.isError) && !nsfwGated;
  const overBanner = scrollY === 0 && bannerShown;
  // Light status bar text over the banner, while this screen is the one shown.
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle(overBanner ? 'light' : 'auto', true);
      return () => setStatusBarStyle('auto', true);
    }, [overBanner]),
  );

  const refreshProfile = () => profileQuery.refetch();

  // Header-bar menus (PRD PROF-05, PROF-13).
  const ownMenu: MenuItem[] = [
    { id: 'bookmarks', title: 'Bookmarks', systemImage: 'bookmark' },
    { id: 'blocked', title: 'Blocked accounts', systemImage: 'nosign' },
    { id: 'settings', title: 'Settings', systemImage: 'gearshape' },
    { id: 'share', title: 'Share profile', systemImage: 'square.and.arrow.up' },
    ...(accounts.length > 1 ? [{ id: 'switch', title: 'Switch account', systemImage: 'person.2' }] : []),
  ];
  const otherMenu: MenuItem[] = [
    { id: 'share', title: 'Share profile', systemImage: 'square.and.arrow.up' },
    { id: 'copy', title: 'Copy profile link', systemImage: 'link' },
    ...(blockedByList
      ? []
      : [
          blocked
            ? { id: 'unblock', title: `Unblock ${handle}`, systemImage: 'checkmark.circle' }
            : { id: 'block', title: `Block ${handle}`, systemImage: 'nosign', destructive: true },
        ]),
  ];
  // The shared unblock: it also brings back the author's posts hidden elsewhere (SAFE-02).
  const unblock = () =>
    requireAuth(() => {
      const ownId = viewerId ?? lastIdentity();
      if (ownId) sendWrite(blockWrite, { viewerId: ownId, userId: profileId, block: false }, safetyCopy.toast.unblocked);
    });
  const onMenu = (id: string) => {
    if (!profileId) return;
    if (id === 'bookmarks') router.push('/bookmarks');
    else if (id === 'blocked') router.push('/settings/blocked');
    else if (id === 'settings') router.push('/settings');
    else if (id === 'switch') router.push('/settings/accounts');
    else if (id === 'share') shareProfile(profileId, name);
    else if (id === 'copy') copyProfileLink(profileId);
    else if (id === 'block')
      requireAuth(() => router.push({ pathname: '/block/[userId]', params: { userId: profileId } }));
    else if (id === 'unblock') unblock();
  };

  const right = profile ? (
    <>
      {isSelf ? (
        <TopBarIcon
          icon={Cog6ToothIcon}
          overBanner={overBanner}
          accessibilityLabel="Settings"
          onPress={() => router.push('/settings')}
          testID="profile-settings"
        />
      ) : null}
      <ContextMenu items={isSelf ? ownMenu : otherMenu} onSelect={onMenu} testID="profile-menu">
        <TopBarIcon icon={EllipsisHorizontalIcon} overBanner={overBanner} accessibilityLabel="Profile options" />
      </ContextMenu>
    </>
  ) : null;

  const chrome = (
    <>
      <Stack.Screen options={{ headerShown: false, title: name || 'Profile' }} />
      <ProfileTopBar title={name} overBanner={overBanner} right={right} />
    </>
  );

  // States with no profile to show.
  let missing: ReactElement | null = null;
  if (!valid) {
    missing = <EmptyState title="Invalid identity ID" icon={ExclamationTriangleIcon} testID="profile-invalid" />;
  } else if (profile === null) {
    missing = (
      <EmptyState
        title="User not found"
        description="This account doesn't exist, or its name couldn't be found right now."
        icon={UserIcon}
        action={{
          label: 'Try again',
          onPress: () => {
            refreshProfile().catch(() => undefined);
          },
        }}
        testID="profile-not-found"
      />
    );
  } else if (!profile && profileQuery.isError) {
    missing = (
      <ErrorState
        onRetry={() => {
          refreshProfile().catch(() => undefined);
        }}
        testID="profile-error"
      />
    );
  }
  if (missing || !profile) {
    return (
      <View className={cn('flex-1', tw.bg)} testID="profile-screen">
        {chrome}
        <View style={{ paddingTop: missing ? barHeight : 0 }} className="flex-1">
          {missing ?? <ProfileHeaderSkeleton bannerHeight={bannerHeight} />}
        </View>
      </View>
    );
  }

  if (nsfwGated) {
    return (
      <View className={cn('flex-1', tw.bg)} testID="profile-screen">
        {chrome}
        <View style={{ paddingTop: barHeight }} className="flex-1 justify-center">
          <EmptyState
            title="This profile may contain adult content"
            description={`${name} marked their profile as NSFW.`}
            icon={ExclamationTriangleIcon}
            iconColor={c.warning}
            testID="profile-nsfw"
          >
            <View className="mt-4 flex-row gap-3">
              <Button
                label="Go back"
                variant="outline"
                onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              />
              <Button label="View profile" onPress={acknowledgeNsfw} testID="profile-nsfw-view" />
            </View>
          </EmptyState>
        </View>
      </View>
    );
  }

  const header = (
    <View onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}>
      <ProfileHeader
        profile={profile}
        isSelf={isSelf}
        following={following}
        blocked={blocked}
        bannerHeight={bannerHeight}
        bannerGated={bannerGated}
        actions={{
          onEdit: () => router.push('/profile/edit'),
          onFollow: () => requireAuth(() => toggleFollow(profileId, handle, following)),
          onMessage: () =>
            requireAuth(() => {
              messageUser(profileId).catch((error: unknown) =>
                appendLog('warn', 'host', `Message from profile failed: ${errorMessage(error)}`),
              );
            }),
          onCopyId: () => copyText(profileId, 'Identity ID copied'),
          onOpenFollowers: () => router.push({ pathname: '/user/[id]/followers', params: { id: profileId } }),
          onOpenFollowing: () => router.push({ pathname: '/user/[id]/following', params: { id: profileId } }),
        }}
      />
      {isSelf && ownTab && !profile.username ? <UsernameCard identityId={profileId} className="mx-4 mb-3" /> : null}
    </View>
  );

  const tabBar = (
    <View className={tw.bg}>
      <TopTabs
        options={tabs.map(({ value, label }) => ({ value, label }))}
        value={shownTab.value}
        onChange={(next) => {
          // The new tab opens at the top unless the tabs were stuck: the bar goes back over the banner.
          if (!tabsStuck) setScrollY(0);
          setTab(next);
        }}
        testID="profile-tabs"
      />
    </View>
  );

  if (blocked) {
    return (
      <View className={cn('flex-1', tw.bg)} testID="profile-screen">
        {chrome}
        <FlashList
          data={[0]}
          renderItem={() => (
            blockedByList ? (
              <EmptyState
                title="This user is blocked"
                description="Blocked by a block list you follow. You won't see their posts in your feeds"
                icon={NoSymbolIcon}
                testID="profile-blocked"
              />
            ) : (
              <EmptyState
                title="You blocked this user"
                description="You won't see their posts in your feeds"
                icon={NoSymbolIcon}
                action={{ label: 'Unblock', onPress: unblock }}
                testID="profile-blocked"
              />
            )
          )}
          ListHeaderComponent={header}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="never"
        />
      </View>
    );
  }

  return (
    <View className={cn('flex-1', tw.bg)} testID="profile-screen">
      {chrome}
      <ProfileTabList
        key={shownTab.value}
        profileId={profileId}
        tab={shownTab.value}
        spec={shownTab}
        header={header}
        tabBar={tabBar}
        onScroll={onScroll}
        onRefreshProfile={refreshProfile}
        stickOffset={headerHeight > 0 ? headerHeight - barHeight : 0}
        startStuck={tabsStuck}
        barHeight={barHeight}
      />
      {tabsStuck ? (
        <View className="absolute left-0 right-0" style={{ top: barHeight }} testID="profile-tabs-stuck">
          {tabBar}
        </View>
      ) : null}
    </View>
  );
}
