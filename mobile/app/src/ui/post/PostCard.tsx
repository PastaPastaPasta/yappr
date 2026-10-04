import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Platform, Pressable, View, type AccessibilityActionEvent } from 'react-native';
import { ArrowPathIcon, EllipsisHorizontalIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import {
  cashtagDisplayToStorage,
  cn,
  formatNumber,
  hashtagDisplayToStorage,
  normalizeDpnsUsername,
  truncateId,
} from '~/lib-allowlist';

import { showActionSheet } from '../action-sheet';
import { Avatar } from '../Avatar';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { handleOf, keepHandlesWhole } from '../handle';
import { IconButton } from '../IconButton';
import { LinkText } from '../LinkText';
import { RichText, type RichTextHandlers } from '../rich-text/RichText';
import { Skeleton } from '../Skeleton';
import { lightImpact } from '../haptics';
import { Text } from '../Text';
import { hitSlopFor, monoFont, tw, useColors, useLargeText } from '../tokens';
import { useMediaUrls } from '../media-url';
import { RelativeTime } from '../RelativeTime';
import { displayText, inlineTargets, splitUrl, stripLink, type InlinePart } from '../rich-text/parse';
import { WriteStatus, writeStatusLinks, type WriteStatusProps } from '../WriteStatus';
import { useRipple } from '../ripple';
import { useRelativeTime } from '../use-relative-time';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MediaGrid, mediaKindLabel } from './MediaGrid';
import { PollCard } from './PollCard';
import { PostActionBar, plural, repostSplitParts, splitPartLabel } from './PostActionBar';
import { DeletedLine, PostStub, stubText } from './PostStub';
import { PrivatePostPlaceholder } from './PrivatePostPlaceholder';
import { QuoteEmbed, QuoteSkeleton } from './QuoteEmbed';
import { SensitiveGate, useSensitiveReveal } from './SensitiveGate';
import type { CardLinkPreview, CardPoll, CardPost, Loadable } from './types';

/** Feed cards clamp long text and link to the detail (UX_SPEC §2.4.4). */
const FEED_MAX_LINES = 12;

export type PostCardVariant = 'feed' | 'detail' | 'compact' | 'optimistic';

export interface PostCardActions extends RichTextHandlers {
  /** Open the post (feed) — the card's own tap. */
  onPress?: () => void;
  /** A long press, when there is no `menu`. */
  onLongPress?: () => void;
  onAuthorPress?: () => void;
  onReposterPress?: () => void;
  /** Copy a nameless author's identity id (PRD AUTH-15). */
  onCopyId?: () => void;
  onMore?: () => void;
  onReply?: () => void;
  onRepost?: () => void;
  onLike?: () => void;
  onBookmark?: () => void;
  onShare?: () => void;
  onQuotePress?: () => void;
  onMediaPress?: (index: number) => void;
  onLinkPreviewPress?: (url: string) => void;
  onVotePress?: () => void;
  onOpenPrivate?: () => void;
  /** Detail only: a count in the counts row, to open that engagements tab (UX_SPEC §4.9). */
  onCountPress?: (tab: EngagementCountTab) => void;
}

/** The counts row's entries, by the engagements tab each one opens. */
export type EngagementCountTab = 'reposts' | 'quotes' | 'likes';

/**
 * Detail only: the counts row's reposts and quotes told apart where
 * `post.stats` lumps them together (v10 keeps a bare repost as a quote
 * post). `truncated`: read off a list that filled up, so floors ("100+").
 */
export interface RepostQuoteCounts {
  reposts: number;
  quotes: number;
  truncated: boolean;
}

export interface PostCardProps {
  post: CardPost;
  variant?: PostCardVariant;
  /** The signed-in identity: "You reposted". */
  viewerId?: string;
  /** Cover with the NSFW gate. The caller applies the viewer's NSFW mode; defaults to `post.sensitive`. */
  nsfwGated?: boolean;
  /** Media from someone the viewer doesn't follow (UX_SPEC §2.7). */
  mediaGated?: boolean;
  onRevealMedia?: () => void;
  linkPreview?: Loadable<CardLinkPreview>;
  poll?: Loadable<CardPoll>;
  /** The quoted post is still loading (shows the quote skeleton). */
  quoteLoading?: boolean;
  /** The quoted post under the viewer's NSFW mode; defaults to `post.quoted.sensitive`. */
  quoteNsfwGated?: boolean;
  /** The quoted author is media-gated for the viewer (their own follow state, not this author's). */
  quoteMediaGated?: boolean;
  /** The parent's handle, for "Replying to @carol". */
  replyingTo?: string;
  /** The author's name is still resolving: skeleton bars in the header. */
  authorPending?: boolean;
  /** Engine capabilities for this post's kind. */
  canRepost?: boolean;
  canBookmark?: boolean;
  /** The viewer's marks are still loading: like, repost and bookmark wait with a spinner (`PostActionBar`). */
  marksLoading?: boolean;
  /** The optimistic variant's write status. */
  writeStatus?: WriteStatusProps;
  /**
   * Detail only: the counts row's reposts and quotes, when `post.stats`
   * cannot tell them apart; `null` while they are unknown, which leaves
   * them out of the row. Omitted, the row reads `post.stats`.
   */
  repostQuoteCounts?: RepostQuoteCounts | null;
  /**
   * The post's menu (PRD ENG-08): the "⋯" dropdown, also shown as an
   * action sheet on a long press and for screen readers. Not a card-wide
   * UIContextMenu: the iOS menu view is a UIButton, which would swallow
   * every tap inside the card.
   */
  menu?: PostCardMenu;
  tagMaxLength?: number;
  actions?: PostCardActions;
}

export interface PostCardMenu {
  items: MenuItem[];
  onSelect: (id: string) => void;
}

const noop = () => undefined;

/**
 * Long press and the screen-reader "More": the menu as an action sheet, after
 * a long-press haptic on Android (UX_SPEC §2.4). Not the "⋯" dropdown from
 * code: @react-native-menu's Android `show()` sends a null command argument,
 * which the New Architecture rejects with a native exception.
 */
function openPostMenu(menu: PostCardMenu) {
  if (Platform.OS === 'android') lightImpact();
  showMenuSheet(menu);
}

/** The menu as an action sheet. */
function showMenuSheet({ items, onSelect }: PostCardMenu) {
  showActionSheet({
    actions: items.map((item) => ({
      label: keepHandlesWhole(item.title),
      destructive: item.destructive,
      onPress: () => onSelect(item.id),
    })),
  });
}

function MoreButton({
  post,
  menu,
  onMore,
}: {
  post: CardPost;
  menu?: PostCardMenu;
  onMore?: () => void;
}) {
  const c = useColors();
  const ripple = useRipple('icon');
  const label = post.kind === 'reply' ? 'Reply options' : 'Post options';
  const testID = `more-btn-${post.id}`;
  if (!menu) {
    return (
      <IconButton
        icon={EllipsisHorizontalIcon}
        accessibilityLabel={label}
        onPress={onMore}
        testID={testID}
        className="-my-1.5 -mr-2"
      />
    );
  }
  // The native menu opens on the tap. The touch's JS target is the menu view itself (on iOS a
  // UIButton, which hides its children from React Native's hit test), so the no-op Pressable
  // around it is what claims the press: without it the card's own press would open the post.
  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={noop}
      testID={testID}
      // 44 pt, like IconButton's hit area (UX_SPEC §6.4), without growing the header.
      className="-my-2.5 -mr-3 h-11 w-11"
    >
      <ContextMenu items={menu.items} onSelect={menu.onSelect} testID={`more-menu-${post.id}`}>
        <View className="h-11 w-11 items-center justify-center">
          <EllipsisHorizontalIcon size={20} color={c.textSecondary} />
        </View>
      </ContextMenu>
    </Pressable>
  );
}

function RepostBanner({
  repostedBy,
  viewerId,
  onPress,
}: {
  repostedBy: NonNullable<CardPost['repostedBy']>;
  viewerId?: string;
  onPress?: () => void;
}) {
  const c = useColors();
  const name =
    repostedBy.id === viewerId
      ? 'You'
      : repostedBy.displayName || (repostedBy.username ? `@${repostedBy.username}` : 'Someone');
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      disabled={!onPress}
      testID="repost-banner"
      // Aligns the label with the text column: 48 avatar + 12 gap − 16 icon − 4 gap.
      className="mb-1 ml-10 flex-row items-center gap-1 self-start"
    >
      <ArrowPathIcon size={16} color={c.textSecondary} />
      <Text variant="subhead" tone="secondary">
        <Text variant="subheadStrong" tone="secondary">
          {name}
        </Text>{' '}
        reposted
      </Text>
    </Pressable>
  );
}

function Header({
  post,
  pending,
  more,
  actions,
}: {
  post: CardPost;
  pending: boolean;
  /** The "⋯" button, when the card has one. */
  more: ReactNode;
  actions: PostCardActions;
}) {
  const c = useColors();
  const largeText = useLargeText();
  const { author } = post;

  const name = pending ? (
    <Skeleton width={96} />
  ) : (
    <Text variant="subheadStrong" numberOfLines={1} style={{ flexShrink: 10 }}>
      {author.displayName}
    </Text>
  );
  const handle = pending ? (
    <Skeleton width={64} />
  ) : author.username ? (
    <Text variant="subhead" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
      @{author.username}
    </Text>
  ) : (
    // A nameless author shows the identity id; tapping copies it.
    <Text
      variant="subhead"
      tone="secondary"
      numberOfLines={1}
      style={[monoFont, { flexShrink: 1 }]}
      onPress={actions.onCopyId}
      accessibilityRole={actions.onCopyId ? 'button' : undefined}
      accessibilityLabel={actions.onCopyId ? 'Copy identity ID' : undefined}
      suppressHighlighting
    >
      {truncateId(author.id)}
    </Text>
  );
  const timeText = (
    <RelativeTime date={post.createdAt} prefix="· " variant="subhead" tone="secondary" className="shrink-0" />
  );

  return (
    <View className="min-h-6 flex-row items-start gap-1">
      {/* At accessibility sizes the handle and time wrap under the name (UX_SPEC §6.1). */}
      <View className={cn('flex-1', largeText ? 'gap-0.5' : 'flex-row items-center gap-1')}>
        {name}
        {largeText ? (
          <View className="flex-row flex-wrap items-center gap-1">
            {handle}
            {timeText}
          </View>
        ) : (
          <>
            {handle}
            {timeText}
          </>
        )}
      </View>
      {post.encrypted ? (
        <View className="h-6 justify-center" accessibilityLabel="Private">
          <LockClosedIcon size={16} color={c.private} />
        </View>
      ) : null}
      {more}
    </View>
  );
}

/** Runs the handler a tap on that span would, normalized as RichText does. */
function pressInline(
  target: InlinePart,
  actions: PostCardActions,
  external: (url: string) => string | null,
  tagMaxLength?: number,
) {
  switch (target.type) {
    case 'mention':
      return actions.onMentionPress?.(normalizeDpnsUsername(target.value.slice(1)));
    case 'hashtag':
      return actions.onHashtagPress?.(hashtagDisplayToStorage(target.value, tagMaxLength));
    case 'cashtag':
      return actions.onCashtagPress?.(cashtagDisplayToStorage(target.value, tagMaxLength));
    case 'url': {
      const url = external(splitUrl(target.value).href);
      return url ? actions.onLinkPress?.(url) : undefined;
    }
  }
}

/** The screen-reader summary of a card (UX_SPEC §6.2). */
function postAccessibilityLabel(
  post: CardPost,
  extras: {
    time: string;
    content: string;
    repostedBy?: string;
    replyingTo?: string;
    quoteCovered: boolean;
    /** Detail: the counts row's reposts and quotes, which the summary repeats (D-L4a-009). */
    repostSplit?: RepostQuoteCounts | null;
  },
): string {
  const parts = [`${post.author.displayName}, ${handleOf(post.author)}, ${extras.time}.`];
  if (extras.repostedBy) parts.push(`Reposted by ${extras.repostedBy}.`);
  if (extras.replyingTo) parts.push(`Replying to @${extras.replyingTo}.`);
  if (post.deleted) parts.push(stubText('deleted', post.kind));
  else if (post.encrypted) parts.push('Private post.');
  else if (extras.content) parts.push(`${extras.content}.`);
  const { quoted } = post;
  if (quoted?.viewer?.authorBlocked) {
    parts.push(`${stubText('blocked', 'post')}.`);
  } else if (quoted) {
    const hidden = extras.quoteCovered || quoted.encrypted || quoted.deleted;
    parts.push(`Quote: ${quoted.author.displayName}${hidden ? '' : `, ${quoted.content}`}.`);
  }
  for (const media of post.media) {
    const kind = mediaKindLabel(media.type);
    parts.push(`${kind}: ${media.alt || kind.toLowerCase()}.`);
  }
  const { replies, reposts, quotes, likes } = post.stats;
  const split = repostSplitParts(extras.repostSplit);
  const shared = split ? split.map(splitPartLabel).join(', ') : plural(reposts + quotes, 'repost', 'reposts');
  parts.push(`${plural(replies, 'reply', 'replies')}, ${shared}, ${plural(likes, 'like', 'likes')}.`);
  return parts.join(' ');
}

/**
 * The post cell (UX_SPEC §2.4, web components/post/post-card.tsx), purely
 * presentational: data in, callbacks out. Variants: `feed` (clamped text),
 * `detail` (full text, larger type, absolute time and counts), `compact`
 * (no action bar; thread parents, compose preview) and `optimistic` (the
 * write-status line instead of the action bar).
 *
 * It is memoized: lists must pass stable props, above all a memoized
 * `actions` object (`useMemo` keyed by the post), or every card re-renders
 * on every list render. The live time is its own leaf (`RelativeTime`).
 */
export const PostCard = memo(function PostCard({
  post,
  variant = 'feed',
  viewerId,
  nsfwGated,
  mediaGated = false,
  onRevealMedia,
  linkPreview,
  poll,
  quoteLoading = false,
  quoteNsfwGated,
  quoteMediaGated = false,
  replyingTo,
  authorPending = false,
  canRepost = true,
  canBookmark = true,
  marksLoading = false,
  writeStatus,
  repostQuoteCounts,
  tagMaxLength,
  menu,
  actions = {},
}: PostCardProps) {
  const [revealed, reveal] = useSensitiveReveal(post.id);
  const { external } = useMediaUrls();
  // Whether the feed text overflowed, keyed by post so a recycled cell re-measures.
  const [clampedId, setClampedId] = useState<string>();
  const clamped = clampedId === post.id;
  const postId = post.id;
  // Stable, so RichText's memo holds across renders.
  const measureClamp = useCallback(
    (lines: number) => {
      if (lines > FEED_MAX_LINES) setClampedId(postId);
    },
    [postId],
  );
  // A legacy poll post shows the poll, not its link (web stripPollrPollLink).
  const pollLink = post.poll?.linkUrl;
  const content = useMemo(
    () => (pollLink ? stripLink(post.content, pollLink) : post.content),
    [post.content, pollLink],
  );
  const previewShown = linkPreview !== undefined && linkPreview !== 'error';

  const ripple = useRipple();
  // Live like the visible time, so the screen reader does not keep the first one.
  const spokenTime = useRelativeTime(post.createdAt, 'spoken');
  if (post.viewer?.authorBlocked) {
    // The stub keeps a menu only where one is given for it (Bookmarks' "Remove bookmark", PRD ENG-04).
    const stubMenu = variant === 'compact' ? undefined : menu;
    return (
      <PostStub
        state="blocked"
        kind={post.kind}
        more={stubMenu ? <MoreButton post={post} menu={stubMenu} /> : undefined}
        onMore={stubMenu ? () => openPostMenu(stubMenu) : undefined}
      />
    );
  }

  const gated = (nsfwGated ?? post.sensitive) && !post.deleted;
  const covered = gated && !revealed;
  const detail = variant === 'detail';
  const posting =
    variant === 'optimistic' &&
    (writeStatus?.status.state === 'posting' || writeStatus?.status.state === 'threadProgress');
  const showActionBar = (variant === 'feed' || detail) && !post.deleted;
  const canReply = !post.encrypted && !post.deleted;
  const repostTotal = post.stats.reposts + post.stats.quotes;
  const reposter = post.repostedBy
    ? post.repostedBy.id === viewerId
      ? 'you'
      : post.repostedBy.displayName || post.repostedBy.username
    : undefined;

  let body: ReactNode;
  if (post.deleted) {
    body = <DeletedLine kind={post.kind} />;
  } else if (post.encrypted) {
    body = <PrivatePostPlaceholder onOpenWeb={actions.onOpenPrivate} />;
  } else {
    let quoteSlot: ReactNode = null;
    if (post.quoted?.viewer?.authorBlocked) {
      quoteSlot = <PostStub state="blocked" variant="embed" />;
    } else if (post.quoted) {
      quoteSlot = (
        <QuoteEmbed
          post={post.quoted}
          nsfwGated={quoteNsfwGated ?? post.quoted.sensitive}
          mediaGated={quoteMediaGated}
          onRevealMedia={onRevealMedia}
          onPress={actions.onQuotePress}
        />
      );
    } else if (post.quotedPostId) {
      if (post.quotedRemoved) quoteSlot = <PostStub state="removed" variant="embed" />;
      else if (quoteLoading) quoteSlot = <QuoteSkeleton />;
      else quoteSlot = <PostStub state="unavailable" variant="embed" />;
    }
    body = (
      <>
        {content ? (
          <View className="mt-0.5">
            <RichText
              text={content}
              variant={detail ? 'bodyLarge' : 'body'}
              numberOfLines={clamped ? FEED_MAX_LINES : undefined}
              hideFirstUrl={previewShown}
              tagMaxLength={tagMaxLength}
              onLineCount={variant === 'feed' && !clamped ? measureClamp : undefined}
              onMentionPress={actions.onMentionPress}
              onHashtagPress={actions.onHashtagPress}
              onCashtagPress={actions.onCashtagPress}
              onLinkPress={actions.onLinkPress}
            />
            {clamped ? (
              <LinkText label="Show more" onPress={actions.onPress} className="mt-1" testID="show-more" />
            ) : null}
          </View>
        ) : null}
        {poll ? <PollCard poll={poll} onVotePress={actions.onVotePress} /> : null}
        {quoteSlot}
        <MediaGrid
          media={post.media}
          gated={mediaGated}
          onReveal={onRevealMedia}
          onMediaPress={actions.onMediaPress}
        />
        {linkPreview ? (
          <LinkPreviewCard
            preview={linkPreview}
            mediaGated={mediaGated}
            onRevealMedia={onRevealMedia}
            onPress={actions.onLinkPreviewPress}
          />
        ) : null}
        {detail ? (
          <DetailMeta post={post} repostQuoteCounts={repostQuoteCounts} onCountPress={actions.onCountPress} />
        ) : null}
      </>
    );
  }

  // The card is one screen-reader element, so everything tappable inside it
  // that is actually shown is offered as a custom action (UX_SPEC §6.2).
  const a11yActions: { name: string; label: string; run?: () => void }[] = [];
  if (covered) {
    a11yActions.push({ name: 'show', label: 'Show', run: reveal });
  } else {
    if (showActionBar) {
      a11yActions.push(
        { name: 'reply', label: 'Reply', run: canReply ? actions.onReply : undefined },
        { name: 'repost', label: 'Repost', run: canRepost ? actions.onRepost : undefined },
        { name: 'like', label: post.viewer?.liked ? 'Unlike' : 'Like', run: actions.onLike },
        {
          name: 'bookmark',
          label: post.viewer?.bookmarked ? 'Remove bookmark' : 'Bookmark',
          run: canBookmark ? actions.onBookmark : undefined,
        },
        { name: 'share', label: 'Share', run: actions.onShare },
      );
    }
    const openCounts = actions.onCountPress;
    if (detail && openCounts && !post.deleted) {
      a11yActions.push({ name: 'engagements', label: 'View post engagements', run: () => openCounts('likes') });
    }
    if (variant === 'optimistic' && writeStatus) {
      for (const link of writeStatusLinks(writeStatus))
        a11yActions.push({ name: link.label, label: link.label, run: link.onPress });
    }
    const previewImage =
      typeof linkPreview === 'object' && Boolean(linkPreview.youtubeVideoId ?? linkPreview.image);
    const { quoted } = post;
    const quoteMediaHidden =
      quoteMediaGated &&
      quoted !== undefined &&
      !quoted.viewer?.authorBlocked &&
      !quoted.deleted &&
      !quoted.encrypted &&
      quoted.media.length > 0;
    if ((mediaGated && (post.media.length > 0 || previewImage)) || quoteMediaHidden)
      a11yActions.push({ name: 'showMedia', label: 'Show media', run: onRevealMedia });
    // Everything tappable inside the card, which VoiceOver can't reach on its own.
    if (!post.deleted && !post.encrypted) {
      for (const target of inlineTargets(displayText(content, previewShown))) {
        const label = `Open ${target.type === 'url' ? splitUrl(target.value).display : target.value}`;
        if (!a11yActions.some((a) => a.name === label)) {
          a11yActions.push({
            name: label,
            label,
            run: () => pressInline(target, actions, external, tagMaxLength),
          });
        }
      }
      if (post.quoted && !post.quoted.viewer?.authorBlocked)
        a11yActions.push({ name: 'quote', label: 'Open quoted post', run: actions.onQuotePress });
      const openPreview = actions.onLinkPreviewPress;
      const previewUrl = typeof linkPreview === 'object' ? external(linkPreview.url) : null;
      if (openPreview && previewUrl) {
        a11yActions.push({ name: 'preview', label: 'Open link preview', run: () => openPreview(previewUrl) });
      }
      const openMedia = actions.onMediaPress;
      if (!mediaGated && openMedia) {
        post.media.forEach((media, i) =>
          a11yActions.push({
            name: `media-${i}`,
            label: `Open ${media.type === 'gif' ? 'GIF' : media.type} ${i + 1}`,
            run: () => openMedia(i),
          }),
        );
      }
    }
  }
  const cardMenu = variant === 'compact' ? undefined : menu;
  const onMore = variant === 'compact' ? undefined : actions.onMore;
  // Long press and the screen-reader action: the "⋯" menu's items as an action sheet.
  const openMenu = cardMenu ? () => openPostMenu(cardMenu) : undefined;
  a11yActions.push(
    { name: 'profile', label: 'Open profile', run: actions.onAuthorPress },
    { name: 'more', label: 'More', run: openMenu ?? onMore },
  );
  const available = a11yActions.filter((a) => a.run);
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'activate') actions.onPress?.();
    else available.find((a) => a.name === e.nativeEvent.actionName)?.run?.();
  };

  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={
        covered
          ? 'NSFW post, hidden'
          : postAccessibilityLabel(post, {
              time: spokenTime,
              content,
              repostedBy: reposter,
              replyingTo,
              quoteCovered: (quoteNsfwGated ?? post.quoted?.sensitive) === true,
              repostSplit: detail ? repostQuoteCounts : undefined,
            })
      }
      accessibilityActions={available.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={onAccessibilityAction}
      onPress={actions.onPress}
      onLongPress={openMenu ?? actions.onLongPress}
      testID={`post-card-${post.id}`}
      className={cn('px-4 pt-3', tw.pressed, variant === 'compact' ? 'pb-3' : cn('border-b pb-1', tw.border))}
    >
      {post.repostedBy ? (
        <RepostBanner repostedBy={post.repostedBy} viewerId={viewerId} onPress={actions.onReposterPress} />
      ) : null}
      <View className="flex-row gap-3">
        <Avatar
          avatar={post.author.avatar}
          identityId={post.author.id}
          size="lg"
          name={post.author.displayName}
          onPress={actions.onAuthorPress}
          testID={`avatar-${post.id}`}
        />
        <View className="min-w-0 flex-1">
          <Header
            post={post}
            pending={authorPending}
            more={
              cardMenu || onMore ? <MoreButton post={post} menu={cardMenu} onMore={onMore} /> : null
            }
            actions={actions}
          />
          {replyingTo ? (
            <Text variant="subhead" tone="secondary" numberOfLines={1}>
              Replying to{' '}
              <Text variant="subhead" tone="link">
                @{replyingTo}
              </Text>
            </Text>
          ) : null}
          {/* Its own native parent, so the body doesn't move when the post lands (mobile/CLAUDE.md, "Native view structure"). */}
          <View collapsable={false} style={posting ? { opacity: 0.7 } : undefined}>
            <SensitiveGate active={gated} revealed={revealed} onReveal={reveal}>
              {body}
            </SensitiveGate>
          </View>
          {showActionBar ? (
            <PostActionBar
              postId={post.id}
              replies={post.stats.replies}
              reposts={repostTotal}
              repostSplit={detail ? repostQuoteCounts : undefined}
              likes={post.stats.likes}
              liked={post.viewer?.liked}
              reposted={post.viewer?.reposted}
              quoted={Boolean(post.viewer?.ownQuoteId) && !post.viewer?.ownQuoteBare}
              bookmarked={post.viewer?.bookmarked}
              canReply={canReply}
              canRepost={canRepost}
              canBookmark={canBookmark}
              marksLoading={marksLoading}
              onReply={actions.onReply}
              onRepost={actions.onRepost}
              onLike={actions.onLike}
              onBookmark={actions.onBookmark}
              onShare={actions.onShare}
            />
          ) : null}
          {variant === 'optimistic' && writeStatus ? <WriteStatus {...writeStatus} postId={post.id} /> : null}
        </View>
      </View>
    </Pressable>
  );
});

/** Detail only: the absolute time and the counts row, non-zero counts only (UX_SPEC §2.4.4, §4.9). */
function DetailMeta({
  post,
  repostQuoteCounts,
  onCountPress,
}: {
  post: CardPost;
  repostQuoteCounts?: RepostQuoteCounts | null;
  onCountPress?: (tab: EngagementCountTab) => void;
}) {
  const date = post.createdAt;
  const when = `${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const split = repostQuoteCounts === undefined ? { ...post.stats, truncated: false } : repostQuoteCounts;
  const floor = split?.truncated ? '+' : '';
  const counts = (
    [
      [split?.reposts ?? 0, floor, 'Repost', 'Reposts', 'reposts'],
      [split?.quotes ?? 0, floor, 'Quote', 'Quotes', 'quotes'],
      [post.stats.likes, '', 'Like', 'Likes', 'likes'],
    ] as const
  ).filter(([n]) => n > 0);
  return (
    <View className="mt-3 gap-3">
      <Text variant="subhead" tone="secondary">
        {when}
      </Text>
      {counts.length > 0 ? (
        <View className={cn('flex-row flex-wrap gap-x-4 gap-y-1 border-y py-3', tw.border)}>
          {counts.map(([n, plus, one, many, tab]) => {
            const label = (
              <Text variant="subhead" tone="secondary">
                <Text variant="subheadStrong" tabular>
                  {formatNumber(n)}
                  {plus}
                </Text>{' '}
                {n === 1 && !plus ? one : many}
              </Text>
            );
            return onCountPress ? (
              <Pressable
                key={tab}
                accessibilityRole="link"
                accessibilityLabel={`${formatNumber(n)}${plus} ${n === 1 && !plus ? one : many}`}
                hitSlop={hitSlopFor(20)}
                onPress={() => onCountPress(tab)}
                testID={`count-${tab}`}
              >
                {({ pressed }) => (
                  <View collapsable={false} className={pressed ? 'opacity-60' : undefined}>
                    {label}
                  </View>
                )}
              </Pressable>
            ) : (
              <View key={tab}>{label}</View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
