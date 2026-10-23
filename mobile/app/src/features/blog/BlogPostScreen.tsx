import type { BlogCommentDTO, BlogDTO, BlogInfoDTO, BlogPostDTO, BlogReportTargetDTO } from '@engine/api';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, Text as RNText, View } from 'react-native';
import { BookOpenIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { useWrite } from '~/data/writes';
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
import { CommentRow, CommentsHeader, CommentsOff, CommentsState, useBlogComments } from './BlogComments';
import { BlogBlock, BlogFootnotes, contentModel, type BlockRow } from './BlogContent';
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
 * Where deleting the post stands. Only a confirmed ticket, or a proved read of
 * the post that finds it deleted, is `deleted`: the engine taking the ticket
 * is only `deleting`. `unconfirmed` may still land; `failed` did not.
 */
type Deletion = 'idle' | 'deleting' | 'unconfirmed' | 'failed' | 'deleted';

const DELETION_TEXT: Record<Exclude<Deletion, 'idle'>, string> = {
  deleting: 'Deleting this post…',
  unconfirmed: "Deleting this post was sent but isn't confirmed yet. It usually shows within a minute or two.",
  failed: "This post wasn't deleted.",
  deleted: 'Post deleted.',
};

/**
 * Deleting the post, followed to its outcome: "Deleting…" while it is on its
 * way, "Post deleted" (and back) only once it is confirmed or a read proves the
 * post gone, and an unconfirmed or failed delete stays said on the screen.
 * `reread` reads the post again and answers whether it is still there.
 */
function usePostDeletion(postId: string | undefined, blogId: string, gone: boolean, reread: () => Promise<boolean>) {
  const navigation = useNavigation();
  const remove = useWrite(deletePostWrite);
  // From the tap until the engine answers with a ticket (or refuses): a second tap must not send another.
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  /** The last call's answer was lost (engine restart, timeout): it may have landed, with no ticket here to follow. */
  const [lost, setLost] = useState(false);
  /** A read after a lost answer found the post still there: deleting it again is offered (a second delete is harmless). */
  const [stillThere, setStillThere] = useState(false);
  const [checking, setChecking] = useState(false);
  const asked = remove.ticket !== null || lost;

  let state: Deletion = 'idle';
  if (remove.status === 'confirmed' || (asked && gone)) state = 'deleted';
  else if (sending || remove.status === 'pending') state = 'deleting';
  // The last call's lost answer outranks an earlier ticket's outcome.
  else if (lost) state = 'unconfirmed';
  // Its call still runs past the engine's deadline (a slow network): its own answer settles it.
  else if (remove.status === 'unconfirmed' && remove.ticket?.error?.code === 'STILL_SENDING') state = 'deleting';
  // Unconfirmed but retryable is proved not to have landed.
  else if (remove.status === 'failed' || (remove.status === 'unconfirmed' && remove.ticket?.retryable === true)) state = 'failed';
  else if (remove.status === 'unconfirmed') state = 'unconfirmed';

  const announced = useRef(false);
  useEffect(() => {
    if (state !== 'deleted' || announced.current) return;
    announced.current = true;
    toast.success('Post deleted');
    // Only while the post is still in front: a delete that lands later never pops another screen.
    if (navigation.isFocused() && router.canGoBack()) router.back();
  }, [state, navigation]);

  const send = () => {
    if (!postId || sendingNow.current) return Promise.resolve();
    sendingNow.current = true;
    setSending(true);
    setLost(false);
    setStillThere(false);
    return remove
      .send({ postId, blogId })
      .then((result) => {
        if (result.status === 'unknown') setLost(true);
      })
      .catch(() => undefined)
      .finally(() => {
        sendingNow.current = false;
        setSending(false);
      });
  };

  const start = () => {
    if (!postId || sendingNow.current) return;
    confirmAlert({ title: 'Delete this post?', message: 'It will be removed from your blog. This can’t be undone.', confirmText: 'Delete', destructive: true })
      .then((ok) => (ok ? send() : undefined))
      .catch(() => undefined);
  };

  // "Check again": the ticket, if there is one, and a read of the post, which proves it gone or not.
  const check = () => {
    if (checking) return;
    setChecking(true);
    Promise.all([remove.ticket ? remove.check() : null, reread()])
      .then(([, there]) => {
        if (lost && there) setStillThere(true);
      })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  return {
    state,
    start,
    check,
    checking,
    /** Delete again: the last answer was lost and a read since found the post still there. */
    again:
      state === 'unconfirmed' && lost && stillThere
        ? () => {
            send().catch(() => undefined);
          }
        : null,
    /**
     * Leaving: the screen keeps what it showed while it goes (the Android rule, mobile/CLAUDE.md).
     * Deleted while the reader was elsewhere, nothing navigates and it shows what it reads.
     */
    frozen: state === 'deleted' && navigation.isFocused() && router.canGoBack(),
  };
}

/** One row of the reader's list. */
type ReaderRow =
  | { type: 'deleted' | 'head' | 'footnotes' | 'follow' | 'comments-off' | 'comments-head' | 'comments-state'; key: string }
  | { type: 'block'; key: string; row: BlockRow }
  | { type: 'comment'; key: string; comment: BlogCommentDTO };

/** The rows before the content's first block: the head. */
const HEAD_ROWS = 1;

const readerRowType = (row: ReaderRow) => (row.type === 'block' ? `block:${String(row.row.block.type ?? 'paragraph')}` : row.type);

/**
 * The reader: a post in its blog's theme (web `blog-post-view.tsx`): title,
 * summary, author, reading time, cover, the content with a working table of
 * contents, the reader's "Aa", share, report, and comments.
 *
 * One virtualized list, with a row for each block of the content and for each
 * comment, so a long post and a hundred comments mount only what is near the
 * screen. The comment draft lives here (`useBlogComments`), not in its row.
 */
function PostReader({ blog: b, post: p, info, follow, deletion, refetchAll }: {
  blog: BlogDTO;
  post: BlogPostDTO;
  info: BlogInfoDTO | undefined;
  follow: ReturnType<typeof useBlogFollow>;
  deletion: ReturnType<typeof usePostDeletion>;
  refetchAll: () => Promise<unknown>;
}) {
  const viewerId = useViewerId();
  const urls = useMediaUrls();
  const { mode, size } = useReaderPrefs();
  const [readerOpen, setReaderOpen] = useState(false);
  const [report, setReport] = useState<BlogReportTargetDTO | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const list = useRef<FlashListRef<ReaderRow>>(null);
  const scrollY = useRef(0);
  const composerActions = useRef<View>(null);

  const palette = useMemo(() => blogPalette(b.theme, mode), [b.theme, mode]);
  const headingFont = useMemo(() => fontStyle(b.theme.fonts.heading), [b.theme.fonts.heading]);
  const bodyFont = useMemo(() => fontStyle(b.theme.fonts.body), [b.theme.fonts.body]);
  const scale = FONT_SCALES[size];
  const own = viewerId === p.ownerId;
  const canReport = Boolean(info?.reports);
  const url = blogPostWebUrl(b.id, p.slug);
  const cover = urls.media(p.coverImage);
  const model = useMemo(() => contentModel(blocksOf(p.content)), [p.content]);

  const onReport = useCallback((target: BlogReportTargetDTO) => requireAuth(() => setReport(target)), []);
  const comments = useBlogComments({
    post: p,
    maxLength: info?.limits.comment ?? 500,
    canReport,
    onReport,
    onReveal: (dy) => list.current?.scrollToOffset({ offset: scrollY.current + dy, animated: true }),
    actionsRef: composerActions,
  });

  const showFollow = !own && Boolean(viewerId) && follow.data?.following === false;
  const onJumpToHeading = useCallback(
    (index: number) => {
      const row = model.headingRows[index];
      if (row === undefined) return;
      // The 12 pt above the heading the old scroll view left, and its animation.
      // The content's rows follow the head row.
      list.current?.scrollToIndex({ index: HEAD_ROWS + row, animated: true, viewOffset: -12 })?.catch(() => undefined);
    },
    [model.headingRows],
  );

  const rows = useMemo(() => {
    const out: ReaderRow[] = [];
    if (p.deleted) {
      out.push({ type: 'deleted', key: 'deleted' });
    } else {
      out.push({ type: 'head', key: 'head' });
      for (const row of model.rows) out.push({ type: 'block', key: `block:${row.key}`, row });
      if (model.footnotes.length > 0) out.push({ type: 'footnotes', key: 'footnotes' });
      if (showFollow) out.push({ type: 'follow', key: 'follow' });
    }
    if (!comments.enabled) {
      out.push({ type: 'comments-off', key: 'comments-off' });
    } else {
      out.push({ type: 'comments-head', key: 'comments-head' });
      if (comments.read !== 'done' || comments.comments.length === 0) out.push({ type: 'comments-state', key: 'comments-state' });
      else for (const comment of comments.comments) out.push({ type: 'comment', key: `comment:${comment.id}`, comment });
    }
    return out;
  }, [p.deleted, model, showFollow, comments.enabled, comments.read, comments.comments]);

  // While a delete may still land (or has), the post is not offered for editing or deleting again.
  const deletable = own && !p.deleted && (deletion.state === 'idle' || deletion.state === 'failed');
  const menu = [
    { id: 'share', title: 'Share', systemImage: 'square.and.arrow.up' },
    { id: 'copy', title: 'Copy link', systemImage: 'link' },
    ...(deletable ? [{ id: 'edit', title: 'Edit post', systemImage: 'pencil' }] : []),
    ...(deletable && info?.canDeletePost ? [{ id: 'delete', title: 'Delete post', systemImage: 'trash', destructive: true }] : []),
    ...(!own && canReport && !p.deleted ? [{ id: 'report', title: 'Report post', systemImage: 'flag', destructive: true }] : []),
  ];

  const onMenu = (action: string) => {
    if (action === 'share') shareLink(url, p.title);
    else if (action === 'copy') copyText(url, 'Link copied');
    else if (action === 'edit') router.push({ pathname: '/blog/[id]/post/[slug]/edit', params: { id: b.id, slug: p.slug } });
    else if (action === 'report') requireAuth(() => setReport({ docType: 'blogPost', targetId: p.id, ownerId: p.ownerId }));
    else if (action === 'delete') deletion.start();
  };

  const onRefresh = () => {
    setRefreshing(true);
    refetchAll()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  // Where deleting the post stands. The list's header, always mounted: a row inserted above the screen would
  // scroll the list to keep its place and push this off it, and the live region would be unmounted far down the post.
  const deletionBanner = deletion.state !== 'idle' ? (
    <View accessibilityLiveRegion="polite" collapsable={false} style={{ gap: 4, paddingBottom: 16 }} testID="blog-post-deletion">
      <RNText style={{ color: palette.muted, fontSize: 15 }}>{DELETION_TEXT[deletion.state]}</RNText>
      {deletion.state === 'unconfirmed' ? (
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <Pressable
            onPress={deletion.check}
            disabled={deletion.checking}
            accessibilityRole="button"
            accessibilityState={{ busy: deletion.checking }}
            style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}
            testID="blog-post-deletion-check"
          >
            <RNText style={{ color: palette.link, fontWeight: '600', fontSize: 15 }}>{deletion.checking ? 'Checking…' : 'Check again'}</RNText>
          </Pressable>
          {deletion.again ? (
            <Pressable
              onPress={deletion.again}
              accessibilityRole="button"
              style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}
              testID="blog-post-deletion-again"
            >
              <RNText style={{ color: palette.link, fontWeight: '600', fontSize: 15 }}>Delete again</RNText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  ) : null;

  const muted = { color: palette.muted, fontSize: 13 * scale };
  const renderItem = ({ item }: { item: ReaderRow }) => {
    switch (item.type) {
      case 'deleted':
        return <RNText style={{ color: palette.muted, fontSize: 16, paddingBottom: 16 }}>This post was deleted by its author.</RNText>;
      case 'head':
        return (
          <View style={{ gap: 16, paddingBottom: 16 }}>
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
          </View>
        );
      case 'block':
        return (
          <BlogBlock
            row={item.row}
            palette={palette}
            bodyFont={bodyFont}
            headingFont={headingFont}
            scale={scale}
            toc={model.toc}
            onJumpToHeading={onJumpToHeading}
          />
        );
      case 'footnotes':
        return <BlogFootnotes notes={model.footnotes} palette={palette} scale={scale} />;
      case 'follow':
        return (
          <View style={{ paddingBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 14, padding: 14 }}>
              <BlogAvatar blog={b} size="sm" />
              <RNText style={{ flex: 1, color: palette.text, fontSize: 14 }}>
                Follow <RNText style={{ color: palette.heading, fontWeight: '700' }}>{b.name}</RNText> to get its new posts
              </RNText>
              <FollowBlogButton blogId={b.id} ownerId={b.ownerId} palette={palette} follow={follow.data} />
            </View>
          </View>
        );
      case 'comments-off':
        return <CommentsOff palette={palette} />;
      case 'comments-head':
        return <CommentsHeader comments={comments} palette={palette} actionsRef={composerActions} />;
      case 'comments-state':
        return (
          <View style={{ paddingTop: 8 }}>
            <CommentsState comments={comments} palette={palette} />
          </View>
        );
      case 'comment':
        // 8 pt between the composer and the comments, and between comments, as the list's `gap` was.
        return (
          <View style={{ paddingTop: 8 }}>
            <CommentRow
              comment={item.comment}
              palette={palette}
              own={item.comment.ownerId === viewerId}
              canReport={comments.canReport}
              onReport={comments.report}
              onDelete={comments.remove}
            />
          </View>
        );
    }
  };

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
        <FlashList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={readerRowType}
          renderItem={renderItem}
          ListHeaderComponent={deletionBanner}
          // As the scroll view this replaced: what is inserted above the screen (a follow card, the banner) pushes the content down.
          maintainVisibleContentPosition={{ disabled: true }}
          style={{ flex: 1, backgroundColor: palette.bg }}
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.accent} colors={[palette.accent]} />}
          testID="blog-post-scroll"
        />
      </KeyboardAvoider>
      <ReaderSheet open={readerOpen} onClose={() => setReaderOpen(false)} />
      {report ? <BlogReportSheet target={report} open onClose={() => setReport(null)} /> : null}
    </Screen>
  );
}

/** A blog post: loads it and its blog, and follows a delete to its outcome. */
export function BlogPostScreen() {
  const { id: blogId, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const offline = useOffline();

  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info(), { staleTime: Infinity });
  const blog = useEngineQuery(queryKeys.blog.detail(blogId), (api) => api.blogs.get(blogId), { persist: true });
  const post = useEngineQuery(queryKeys.blog.postBySlug(blogId, slug), (api) => api.blogs.postBySlug(blogId, slug), { persist: true });
  const follow = useBlogFollow(blogId, Boolean(blog.data));
  // A read of the post that finds it deleted, or no longer there.
  const gone = post.data === null || post.data?.deleted === true;
  const refetchPost = post.refetch;
  const reread = useCallback(() => refetchPost().then((read) => Boolean(read.data && !read.data.deleted)), [refetchPost]);
  const deletion = usePostDeletion(post.data?.id, blogId, gone, reread);
  // The post as last shown. Once deleted it stays on screen while the screen leaves: the read that
  // proved it gone must not change the tree in the render that pops (Android, mobile/CLAUDE.md).
  const [kept, setKept] = useState<{ blog: BlogDTO; post: BlogPostDTO } | null>(null);
  const live = blog.data && post.data ? { blog: blog.data, post: post.data } : null;
  if (!deletion.frozen && (kept?.blog !== live?.blog || kept?.post !== live?.post)) setKept(live);

  const view = deletion.frozen ? (kept ?? live) : live;
  if (!view) {
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

  return (
    <PostReader
      blog={view.blog}
      post={view.post}
      info={info.data}
      follow={follow}
      deletion={deletion}
      refetchAll={() => Promise.all([blog.refetch(), post.refetch(), follow.refetch()])}
    />
  );
}
