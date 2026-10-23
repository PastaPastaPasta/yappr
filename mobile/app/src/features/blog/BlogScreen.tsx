import type { BlogDTO, BlogPostSummaryDTO } from '@engine/api';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, Text as RNText, View } from 'react-native';
import { BookOpenIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { readErrorMessage, useOffline } from '~/features/explore/states';
import { openUser } from '~/features/post/post-navigation';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { useMediaUrls } from '~/ui/media-url';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { ModerationLabel } from '~/ui/post/ModerationLabel';
import { MIN_TARGET } from '~/ui/tokens';

import { BlogAvatar, postMeta } from './BlogCards';
import { BlogMenu, BlogStatusBar, FollowBlogButton, blogHeaderOptions, useBlogFollow } from './BlogChrome';
import { BlogHiddenScreen } from './BlogHidden';
import { blogWebUrl, openBlogPost, shareLink } from './blog-navigation';
import { BlogReportSheet } from './BlogReportSheet';
import { blogPalette, fontStyle, onColor, type BlogPalette } from './blog-theme';

const followers = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'follower' : 'followers'}`;

function ThemedPostRow({ post, palette, blog }: { post: BlogPostSummaryDTO; palette: BlogPalette; blog: BlogDTO }) {
  const urls = useMediaUrls();
  const cover = urls.media(post.coverImage, 'thumbnail');
  return (
    <Pressable
      onPress={() => openBlogPost(post.blogId, post.slug)}
      accessibilityRole="button"
      accessibilityLabel={post.publishedAt ? post.title : `${post.title}, draft`}
      style={{ marginHorizontal: 16, marginBottom: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, flexDirection: 'row', gap: 12 }}
      testID={`blog-post-${post.slug}`}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <RNText style={{ ...fontStyle(blog.theme.fonts.heading), color: palette.heading, fontSize: 18, fontWeight: '700' }} numberOfLines={2}>
          {post.title}
        </RNText>
        {post.excerpt ? (
          <RNText style={{ ...fontStyle(blog.theme.fonts.body), color: palette.text, fontSize: 15, lineHeight: 21 }} numberOfLines={3}>
            {post.excerpt}
          </RNText>
        ) : null}
        <RNText style={{ color: post.publishedAt ? palette.muted : palette.accent, fontSize: 13 }}>{postMeta(post)}</RNText>
      </View>
      {cover ? <Image source={{ uri: cover }} style={{ width: 80, height: 80, borderRadius: 10 }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
    </Pressable>
  );
}

function BlogHeader({ blog, palette, followCount, follow }: { blog: BlogDTO; palette: BlogPalette; followCount: number | null; follow: ReturnType<typeof useBlogFollow> }) {
  const urls = useMediaUrls();
  const viewerId = useViewerId();
  const own = viewerId === blog.ownerId;
  const banner = blog.theme.headerStyle !== 'minimal' ? urls.media(blog.headerImage) : undefined;
  const author = blog.owner ? handleOf(blog.owner) : null;
  return (
    <View style={{ paddingBottom: 16 }}>
      {banner ? (
        <Image
          source={{ uri: banner }}
          style={{ width: '100%', height: blog.theme.headerStyle === 'hero' ? 180 : 120 }}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <BlogAvatar blog={blog} size="xl" />
          <View style={{ flex: 1 }}>
            <RNText
              accessibilityRole="header"
              style={{ ...fontStyle(blog.theme.fonts.heading), color: palette.heading, fontSize: 26, fontWeight: '800' }}
            >
              {blog.name}
            </RNText>
            {author ? (
              <Pressable onPress={() => openUser(blog.ownerId)} accessibilityRole="link" hitSlop={8}>
                <RNText style={{ color: palette.link, fontSize: 14 }}>{author}</RNText>
              </Pressable>
            ) : null}
          </View>
        </View>
        {blog.description ? (
          <RNText style={{ ...fontStyle(blog.theme.fonts.body), color: palette.text, fontSize: 16, lineHeight: 23 }}>{blog.description}</RNText>
        ) : null}
        {blog.labels.length > 0 ? (
          <RNText style={{ color: palette.muted, fontSize: 14 }}>{blog.labels.join(' · ')}</RNText>
        ) : null}
        <ModerationLabel moderation={blog.moderation} testID="blog-moderation-label" />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {followCount !== null ? <RNText style={{ color: palette.muted, fontSize: 14 }}>{followers(followCount)}</RNText> : null}
          <View style={{ flex: 1 }} />
          {own ? (
            <>
              <Pressable
                onPress={() => router.push({ pathname: '/blog/[id]/settings', params: { id: blog.id } })}
                accessibilityRole="button"
                style={{ minHeight: MIN_TARGET, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: palette.border, justifyContent: 'center' }}
                testID="blog-settings"
              >
                <RNText style={{ color: palette.link, fontWeight: '600' }}>Settings</RNText>
              </Pressable>
              <Pressable
                onPress={() => router.push({ pathname: '/blog/[id]/write', params: { id: blog.id } })}
                accessibilityRole="button"
                style={{ minHeight: MIN_TARGET, paddingHorizontal: 16, borderRadius: 999, backgroundColor: palette.link, justifyContent: 'center' }}
                testID="blog-write"
              >
                <RNText style={{ color: onColor(palette.link), fontWeight: '600' }}>Write a post</RNText>
              </Pressable>
            </>
          ) : (
            <FollowBlogButton blogId={blog.id} ownerId={blog.ownerId} palette={palette} follow={follow.data} />
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * A blog's home page in its own theme (web `blog-home.tsx`). A blog the
 * moderators hid is a stub on the official apps, its posts included (blog
 * v10); an archival build shows it labelled.
 */
export function BlogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const viewerId = useViewerId();
  const offline = useOffline();
  const [reporting, setReporting] = useState(false);
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info(), { staleTime: Infinity });
  const blog = useEngineQuery(queryKeys.blog.detail(id), (api) => api.blogs.get(id), { persist: true });
  const withheld = blog.data?.moderation?.withheld === true;
  const shown = Boolean(blog.data) && !withheld;
  const posts = useEngineInfiniteQuery(queryKeys.blog.posts(id), (api, cursor) => api.blogs.posts(id, cursor), {
    persist: true,
    enabled: shown,
  });
  const follow = useBlogFollow(id, shown);
  const [refreshing, setRefreshing] = useState(false);

  if (withheld) return <BlogHiddenScreen title="Blog" noun="blog" />;

  if (!blog.data) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Blog' }} />
        {blog.isPending ? (
          <View className="items-center py-12">
            <Spinner />
          </View>
        ) : blog.isError ? (
          <ErrorState
            title="Couldn't load this blog"
            message={readErrorMessage(blog.error, offline)}
            onRetry={() => {
              blog.refetch().catch(() => undefined);
            }}
            retrying={blog.isRetrying}
          />
        ) : (
          <EmptyState icon={BookOpenIcon} title="This blog is no longer available" description="It may have been deleted by its author." />
        )}
      </Screen>
    );
  }

  const data = blog.data;
  const palette = blogPalette(data.theme);
  const own = viewerId === data.ownerId;
  const menu = [
    { id: 'share', title: 'Share', systemImage: 'square.and.arrow.up' },
    ...(!own && info.data?.reports ? [{ id: 'report', title: 'Report blog', systemImage: 'flag', destructive: true }] : []),
  ];

  const onRefresh = () => {
    setRefreshing(true);
    Promise.all([blog.refetch(), posts.refetch(), follow.refetch()])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          ...blogHeaderOptions(palette, ''),
          headerRight: () => (
            <BlogMenu
              items={menu}
              palette={palette}
              label="More blog options"
              testID="blog-menu"
              onSelect={(action) => {
                if (action === 'share') shareLink(blogWebUrl(data.id), data.name);
                else if (action === 'report') requireAuth(() => setReporting(true));
              }}
            />
          ),
        }}
      />
      <BlogStatusBar palette={palette} />
      <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <FlashList
          data={posts.items}
          keyExtractor={(post) => post.id}
          renderItem={({ item }) => <ThemedPostRow post={item} palette={palette} blog={data} />}
          ListHeaderComponent={<BlogHeader blog={data} palette={palette} followCount={follow.data?.followers ?? null} follow={follow} />}
          ListEmptyComponent={
            posts.isPending ? (
              <View className="items-center py-8">
                <Spinner />
              </View>
            ) : posts.isError ? (
              <ErrorState
                title="Couldn't load posts"
                message={readErrorMessage(posts.error, offline)}
                onRetry={() => {
                  posts.refetch().catch(() => undefined);
                }}
                retrying={posts.isRetrying}
              />
            ) : (
              <RNText style={{ color: palette.muted, textAlign: 'center', padding: 24, fontSize: 15 }}>
                {own ? 'Write your first post to get started.' : 'No posts yet.'}
              </RNText>
            )
          }
          onEndReached={() => {
            if (posts.hasNextPage && !posts.isFetchingNextPage) posts.fetchNextPage().catch(() => undefined);
          }}
          ListFooterComponent={posts.isFetchingNextPage ? <View className="py-4"><Spinner /></View> : <View style={{ height: 32 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.accent} colors={[palette.accent]} />}
        />
      </View>
      {reporting ? (
        <BlogReportSheet target={{ docType: 'blog', targetId: data.id, ownerId: data.ownerId }} open onClose={() => setReporting(false)} />
      ) : null}
    </Screen>
  );
}
