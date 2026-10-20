import type { BlogDTO, BlogPostSummaryDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { BookOpenIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { readErrorMessage, useOffline } from '~/features/explore/states';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { SegmentedControl } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { MIN_TARGET, tw, useColors } from '~/ui/tokens';

import { BlogRow, PostCard } from './BlogCards';

type Segment = 'blogs' | 'posts' | 'following';

type Row = { type: 'blog'; key: string; blog: BlogDTO } | { type: 'post'; key: string; post: BlogPostSummaryDTO };

/**
 * Blogs (web `/blog`, `blog-discovery.tsx`): every blog newest first, the
 * newest posts across blogs, and the blogs the viewer follows. "Your blogs"
 * leads to writing.
 */
export function BlogsHomeScreen() {
  const c = useColors();
  const viewerId = useViewerId();
  const offline = useOffline();
  const params = useLocalSearchParams<{ view?: string }>();
  const [segment, setSegment] = useState<Segment>(params.view === 'posts' ? 'posts' : 'blogs');
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info(), { staleTime: Infinity });
  const blogs = useEngineInfiniteQuery(queryKeys.blog.discover, (api, cursor) => api.blogs.discover(cursor), {
    persist: true,
    enabled: segment === 'blogs',
  });
  const posts = useEngineInfiniteQuery(queryKeys.blog.latestPosts, (api, cursor) => api.blogs.latestPosts(cursor), {
    persist: true,
    enabled: segment === 'posts',
  });
  const followed = useEngineQuery(queryKeys.blog.followed, (api) => api.blogs.followed(), {
    enabled: segment === 'following' && viewerId !== null,
  });

  const segments = [
    { value: 'blogs' as const, label: 'Blogs' },
    ...(info.data?.canDeletePost !== false ? [{ value: 'posts' as const, label: 'Posts' }] : []),
    ...(viewerId ? [{ value: 'following' as const, label: 'Following' }] : []),
  ];
  const shown: Segment = segments.some((s) => s.value === segment) ? segment : 'blogs';

  const rows: Row[] =
    shown === 'blogs'
      ? blogs.items.map((blog) => ({ type: 'blog', key: `b:${blog.id}`, blog }))
      : shown === 'posts'
        ? posts.items.map((post) => ({ type: 'post', key: `p:${post.id}`, post }))
        : (followed.data ?? []).map((blog) => ({ type: 'blog', key: `f:${blog.id}`, blog }));
  const active = shown === 'blogs' ? blogs : shown === 'posts' ? posts : followed;
  const paged = shown === 'blogs' ? blogs : shown === 'posts' ? posts : null;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    active
      .refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  let empty;
  if (info.data && !info.data.available) {
    empty = <EmptyState icon={BookOpenIcon} title="Blogs aren't available yet" description="Check back soon." />;
  } else if (active.isPending && active.fetchStatus !== 'idle') {
    empty = (
      <View className="items-center py-12">
        <Spinner />
      </View>
    );
  } else if (active.isError) {
    empty = (
      <ErrorState
        title="Couldn't load blogs"
        message={readErrorMessage(active.error, offline)}
        onRetry={() => {
          active.refetch().catch(() => undefined);
        }}
        retrying={'isRetrying' in active ? Boolean(active.isRetrying) : false}
      />
    );
  } else if (shown === 'following') {
    empty = (
      <EmptyState
        icon={BookOpenIcon}
        title="You're not following any blogs"
        description="Follow a blog to keep up with its new posts."
        action={{ label: 'Find blogs', onPress: () => setSegment('blogs') }}
      />
    );
  } else {
    empty = (
      <EmptyState
        icon={BookOpenIcon}
        title={shown === 'posts' ? 'No posts yet' : 'No blogs yet'}
        description="Longer posts from Yappr writers will show up here."
      />
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: 'Blogs',
          headerRight: viewerId
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push('/blogs/mine')}
                  hitSlop={8}
                  style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}
                  testID="blogs-mine"
                >
                  <Text tone="link">Your blogs</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        renderItem={({ item }) => (item.type === 'blog' ? <BlogRow blog={item.blog} /> : <PostCard post={item.post} showBlog />)}
        ListHeaderComponent={
          segments.length > 1 ? (
            <View className={cn('border-b px-4 py-3', tw.border)}>
              <SegmentedControl options={segments} value={shown} onChange={setSegment} testID="blogs-segments" />
            </View>
          ) : null
        }
        ListEmptyComponent={empty}
        ListFooterComponent={
          paged?.hasNextPage ? (
            <View className="items-center py-4">
              {paged.isFetchingNextPage ? (
                <Spinner />
              ) : (
                <Button
                  label="Load more"
                  variant="ghost"
                  onPress={() => {
                    paged.fetchNextPage().catch(() => undefined);
                  }}
                  testID="blogs-load-more"
                />
              )}
            </View>
          ) : null
        }
        onEndReached={() => {
          if (paged?.hasNextPage && !paged.isFetchingNextPage) paged.fetchNextPage().catch(() => undefined);
        }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} colors={[c.accent]} />}
      />
    </Screen>
  );
}
