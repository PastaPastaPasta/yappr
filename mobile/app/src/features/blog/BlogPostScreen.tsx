import type { BlogDTO, BlogPostDTO, BlogReportTargetDTO } from '@engine/api';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text as RNText, View } from 'react-native';
import { BookOpenIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { runWrite } from '~/data/writes';
import { readErrorMessage, useOffline } from '~/features/explore/states';
import { copyText } from '~/features/post/post-navigation';
import { confirmAlert } from '~/ui/Dialog';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { useMediaUrls } from '~/ui/media-url';
import { Screen } from '~/ui/Screen';
import { Sheet } from '~/ui/Sheet';
import { Spinner } from '~/ui/Spinner';
import { FilterChips, SegmentedControl } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { MIN_TARGET } from '~/ui/tokens';
import { useRelativeTime } from '~/ui/use-relative-time';

import { BlogAvatar } from './BlogCards';
import { BlogMenu, BlogStatusBar, FollowBlogButton, blogHeaderOptions, useBlogFollow } from './BlogChrome';
import { BlogComments } from './BlogComments';
import { BlogContent } from './BlogContent';
import { blocksOf } from './blocks';
import { blogPostWebUrl, openBlog, shareLink } from './blog-navigation';
import { BlogReportSheet } from './BlogReportSheet';
import {
  blogPalette,
  FONT_SCALES,
  FONT_SIZE_OPTIONS,
  fontStyle,
  READING_MODE_OPTIONS,
  useReaderPrefs,
  type BlogPalette,
} from './blog-theme';
import { deletePostWrite } from './blog-writes';

/** The reader's "Aa" sheet (web `reading-preferences.tsx`). */
function ReaderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mode, size } = useReaderPrefs();
  return (
    <Sheet open={open} onClose={onClose} title="Reading" testID="blog-reader-sheet">
      <View className="gap-4 px-4 pb-6">
        <View className="gap-2">
          <Text variant="subheadStrong">Colors</Text>
          <SegmentedControl options={READING_MODE_OPTIONS} value={mode} onChange={(next) => useReaderPrefs.setState({ mode: next })} testID="blog-reader-mode" />
        </View>
        <View className="gap-2">
          <Text variant="subheadStrong">Text size</Text>
          <FilterChips options={FONT_SIZE_OPTIONS} value={size} onChange={(next) => useReaderPrefs.setState({ size: next })} testID="blog-reader-size" />
        </View>
      </View>
    </Sheet>
  );
}

function AuthorRow({ blog, post, palette, follow }: { blog: BlogDTO; post: BlogPostDTO; palette: BlogPalette; follow: ReturnType<typeof useBlogFollow> }) {
  const when = useRelativeTime(post.date);
  const handle = blog.owner ? handleOf(blog.owner) : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Pressable onPress={() => openBlog(blog.id)} accessibilityRole="link" accessibilityLabel={`Open ${blog.name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minHeight: MIN_TARGET }} testID="blog-post-blog">
        <BlogAvatar blog={blog} />
        <View style={{ flex: 1 }}>
          <RNText style={{ color: palette.heading, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>{blog.name}</RNText>
          <RNText style={{ color: palette.muted, fontSize: 13 }} numberOfLines={1}>{[handle, when].filter(Boolean).join(' · ')}</RNText>
        </View>
      </Pressable>
      <FollowBlogButton blogId={blog.id} ownerId={blog.ownerId} palette={palette} follow={follow.data} />
    </View>
  );
}

/**
 * A blog post in its blog's theme (web `blog-post-view.tsx`): title,
 * summary, author, reading time, cover, the content with a working table of
 * contents, the reader's "Aa", share, report, and comments.
 */
export function BlogPostScreen() {
  const { id: blogId, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const viewerId = useViewerId();
  const offline = useOffline();
  const urls = useMediaUrls();
  const { mode, size } = useReaderPrefs();
  const [readerOpen, setReaderOpen] = useState(false);
  const [report, setReport] = useState<BlogReportTargetDTO | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const contentY = useRef(0);
  const scrollY = useRef(0);
  const headingY = useRef(new Map<number, number>());

  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info(), { staleTime: Infinity });
  const blog = useEngineQuery(queryKeys.blog.detail(blogId), (api) => api.blogs.get(blogId), { persist: true });
  const post = useEngineQuery(queryKeys.blog.postBySlug(blogId, slug), (api) => api.blogs.postBySlug(blogId, slug), { persist: true });
  const follow = useBlogFollow(blogId, Boolean(blog.data));

  const onHeadingLayout = useCallback((index: number, y: number) => {
    headingY.current.set(index, y);
  }, []);
  const onJumpToHeading = useCallback((index: number) => {
    const y = headingY.current.get(index);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, contentY.current + y - 12), animated: true });
  }, []);
  const onRevealComposer = useCallback((dy: number) => {
    scroll.current?.scrollTo({ y: scrollY.current + dy, animated: true });
  }, []);

  if (!blog.data || !post.data) {
    const failed = blog.isError ? blog : post.isError ? post : null;
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Post' }} />
        {blog.isPending || post.isPending ? (
          <View className="items-center py-12">
            <Spinner />
          </View>
        ) : failed ? (
          <ErrorState
            title="Couldn't load this post"
            message={readErrorMessage(failed.error, offline)}
            onRetry={() => {
              failed.refetch().catch(() => undefined);
            }}
            retrying={failed.isRetrying}
          />
        ) : (
          <EmptyState icon={BookOpenIcon} title="This post isn't available" description="It may have been deleted, or its blog removed." />
        )}
      </Screen>
    );
  }

  const b = blog.data;
  const p = post.data;
  const palette = blogPalette(b.theme, mode);
  const scale = FONT_SCALES[size];
  const own = viewerId === p.ownerId;
  const canReport = Boolean(info.data?.reports);
  const url = blogPostWebUrl(b.id, p.slug);
  const cover = urls.media(p.coverImage);
  const headingFont = fontStyle(b.theme.fonts.heading);
  const bodyFont = fontStyle(b.theme.fonts.body);

  const menu = [
    { id: 'share', title: 'Share', systemImage: 'square.and.arrow.up' },
    { id: 'copy', title: 'Copy link', systemImage: 'link' },
    ...(own && !p.deleted ? [{ id: 'edit', title: 'Edit post', systemImage: 'pencil' }] : []),
    ...(own && !p.deleted && info.data?.canDeletePost ? [{ id: 'delete', title: 'Delete post', systemImage: 'trash', destructive: true }] : []),
    ...(!own && canReport && !p.deleted ? [{ id: 'report', title: 'Report post', systemImage: 'flag', destructive: true }] : []),
  ];

  const onMenu = (action: string) => {
    if (action === 'share') shareLink(url, p.title);
    else if (action === 'copy') copyText(url, 'Link copied');
    else if (action === 'edit') router.push({ pathname: '/blog/[id]/post/[slug]/edit', params: { id: b.id, slug: p.slug } });
    else if (action === 'report') requireAuth(() => setReport({ docType: 'blogPost', targetId: p.id, ownerId: p.ownerId }));
    else if (action === 'delete') {
      confirmAlert({ title: 'Delete this post?', message: 'It will be removed from your blog. This can’t be undone.', confirmText: 'Delete', destructive: true })
        .then((ok) => {
          if (!ok) return;
          return runWrite(deletePostWrite, { postId: p.id, blogId: b.id }).then((result) => {
            if (result.status === 'submitted') {
              toast.success('Post deleted');
              router.back();
            }
          });
        })
        .catch(() => undefined);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    Promise.all([blog.refetch(), post.refetch(), follow.refetch()])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  const muted = { color: palette.muted, fontSize: 13 * scale };
  return (
    <Screen>
      <Stack.Screen
        options={{
          ...blogHeaderOptions(palette, ''),
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                onPress={() => setReaderOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Reading options"
                style={{ width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }}
                testID="blog-reader-options"
              >
                <RNText style={{ color: palette.heading, fontSize: 18, fontWeight: '600' }}>Aa</RNText>
              </Pressable>
              <BlogMenu items={menu} onSelect={onMenu} palette={palette} label="More post options" testID="blog-post-menu" />
            </View>
          ),
        }}
      />
      <BlogStatusBar palette={palette} />
      <KeyboardAvoider avoidOnIOS>
        <ScrollView
          ref={scroll}
          style={{ flex: 1, backgroundColor: palette.bg }}
          contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.accent} colors={[palette.accent]} />}
          testID="blog-post-scroll"
        >
          {p.deleted ? (
            <RNText style={{ color: palette.muted, fontSize: 16 }}>This post was deleted by its author.</RNText>
          ) : (
            <>
              <View style={{ gap: 8 }}>
                {!p.publishedAt ? <RNText style={{ color: palette.accent, fontWeight: '700', fontSize: 13 }}>DRAFT</RNText> : null}
                <RNText accessibilityRole="header" style={{ ...headingFont, color: palette.heading, fontSize: 30 * scale, lineHeight: 37 * scale, fontWeight: '800' }} testID="blog-post-title">
                  {p.title}
                </RNText>
                {p.summary ? <RNText style={{ ...bodyFont, color: palette.muted, fontSize: 18 * scale, lineHeight: 26 * scale }}>{p.summary}</RNText> : null}
              </View>
              <AuthorRow blog={b} post={p} palette={palette} follow={follow} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, borderTopWidth: 1, borderBottomWidth: 1, borderColor: palette.border, paddingVertical: 10 }}>
                <RNText style={muted}>{`${p.readingMinutes} min read`}</RNText>
                {p.labels.length > 0 ? <RNText style={muted}>{`· ${p.labels.join(', ')}`}</RNText> : null}
                {p.edited ? <RNText style={muted}>· edited</RNText> : null}
              </View>
              {cover ? (
                <Image source={{ uri: cover }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 16 }} contentFit="cover" accessibilityLabel={p.title} accessibilityIgnoresInvertColors />
              ) : null}
              <View onLayout={(e) => { contentY.current = e.nativeEvent.layout.y; }}>
                <BlogContent
                  blocks={blocksOf(p.content)}
                  palette={palette}
                  bodyFont={bodyFont}
                  headingFont={headingFont}
                  scale={scale}
                  onHeadingLayout={onHeadingLayout}
                  onJumpToHeading={onJumpToHeading}
                />
              </View>
              {!own && viewerId && follow.data?.following === false ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 14, padding: 14 }}>
                  <BlogAvatar blog={b} size="sm" />
                  <RNText style={{ flex: 1, color: palette.text, fontSize: 14 }}>
                    Follow <RNText style={{ color: palette.heading, fontWeight: '700' }}>{b.name}</RNText> to get its new posts
                  </RNText>
                  <FollowBlogButton blogId={b.id} ownerId={b.ownerId} palette={palette} follow={follow.data} />
                </View>
              ) : null}
            </>
          )}
          <BlogComments
            post={p}
            palette={palette}
            maxLength={info.data?.limits.comment ?? 500}
            canReport={canReport}
            onReport={(target) => requireAuth(() => setReport(target))}
            onReveal={onRevealComposer}
          />
        </ScrollView>
      </KeyboardAvoider>
      <ReaderSheet open={readerOpen} onClose={() => setReaderOpen(false)} />
      {report ? <BlogReportSheet target={report} open onClose={() => setReport(null)} /> : null}
    </Screen>
  );
}
