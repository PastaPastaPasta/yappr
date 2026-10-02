import type { MenuComponentRef } from '@react-native-menu/menu';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Platform, Pressable, View, type AccessibilityActionEvent, type TextLayoutEvent } from 'react-native';
import { ArrowPathIcon, EllipsisHorizontalIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import {
  cashtagDisplayToStorage,
  cn,
  formatNumber,
  formatTime,
  hashtagDisplayToStorage,
  normalizeDpnsUsername,
  truncateId,
} from '~/lib-allowlist';

import { showActionSheet } from '../action-sheet';
import { Avatar } from '../Avatar';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { handleOf } from '../handle';
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
import { LinkPreviewCard } from './LinkPreviewCard';
import { MediaGrid, mediaKindLabel } from './MediaGrid';
import { PollCard } from './PollCard';
import { PostActionBar } from './PostActionBar';
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
  /** The optimistic variant's write status. */
  writeStatus?: WriteStatusProps;
  /**
   * The post's menu (PRD ENG-08): the "⋯" dropdown, also opened by a long
   * press (Android) or shown as an action sheet (iOS long press, screen
   * readers). Not a card-wide UIContextMenu: the iOS menu view is a
   * UIButton, which would swallow every tap inside the card.
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

/** Long press and the screen-reader "More": Android's "⋯" dropdown, or the action sheet. */
function openPostMenu(menu: PostCardMenu, dropdown: MenuComponentRef | null) {
  if (Platform.OS === 'android' && dropdown) {
    lightImpact();
    dropdown.show();
  } else {
    showMenuSheet(menu);
  }
}

/** The menu as an action sheet (iOS long press, screen readers). */
function showMenuSheet({ items, onSelect }: PostCardMenu) {
  showActionSheet({
    actions: items.map((item) => ({
      label: item.title,
      destructive: item.destructive,
      onPress: () => onSelect(item.id),
    })),
  });
}

function MoreButton({
  post,
  menu,
  menuRef,
  onMore,
}: {
  post: CardPost;
  menu?: PostCardMenu;
  menuRef: (menu: MenuComponentRef | null) => void;
  onMore?: () => void;
}) {
  const c = useColors();
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
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={noop}
      testID={testID}
      // 44 pt, like IconButton's hit area (UX_SPEC §6.4), without growing the header.
      className="-my-2.5 -mr-3 h-11 w-11"
    >
      <ContextMenu ref={menuRef} items={menu.items} onSelect={menu.onSelect} testID={`more-menu-${post.id}`}>
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
  extras: { content: string; repostedBy?: string; replyingTo?: string; quoteCovered: boolean },
): string {
  // The spoken form ("5 minutes ago"): "5m" reads as "5 meters".
  const parts = [`${post.author.displayName}, ${handleOf(post.author)}, ${formatTime(post.createdAt)}.`];
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
  parts.push(`${replies} replies, ${reposts + quotes} reposts, ${likes} likes.`);
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
  writeStatus,
  tagMaxLength,
  menu,
  actions = {},
}: PostCardProps) {
  // The "⋯" dropdown, held in state (a callback ref) so long press can open it on Android.
  const [dropdown, setDropdown] = useState<MenuComponentRef | null>(null);
  const [revealed, reveal] = useSensitiveReveal(post.id);
  const { external } = useMediaUrls();
  // Whether the feed text overflowed, keyed by post so a recycled cell re-measures.
  const [clampedId, setClampedId] = useState<string>();
  const clamped = clampedId === post.id;
  const postId = post.id;
  // Stable, so RichText's memo holds across renders.
  const measureClamp = useCallback(
    (e: TextLayoutEvent) => {
      if (e.nativeEvent.lines.length > FEED_MAX_LINES) setClampedId(postId);
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

  if (post.viewer?.authorBlocked) return <PostStub state="blocked" kind={post.kind} />;

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
    body = <PrivatePostPlaceholder name={post.author.displayName} onOpenWeb={actions.onOpenPrivate} />;
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
              onTextLayout={variant === 'feed' && !clamped ? measureClamp : undefined}
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
        {detail ? <DetailMeta post={post} onCountPress={actions.onCountPress} /> : null}
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
  // Long press and the screen-reader action. Android opens the "⋯" dropdown; iOS can't open a
  // UIMenu from code, so it gets the same items as an action sheet.
  const openMenu = cardMenu ? () => openPostMenu(cardMenu, dropdown) : undefined;
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
      accessibilityRole="button"
      accessibilityLabel={
        covered
          ? 'NSFW post, hidden'
          : postAccessibilityLabel(post, {
              content,
              repostedBy: reposter,
              replyingTo,
              quoteCovered: (quoteNsfwGated ?? post.quoted?.sensitive) === true,
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
              cardMenu || onMore ? <MoreButton post={post} menu={cardMenu} menuRef={setDropdown} onMore={onMore} /> : null
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
          <View style={posting ? { opacity: 0.7 } : undefined}>
            <SensitiveGate active={gated} revealed={revealed} onReveal={reveal}>
              {body}
            </SensitiveGate>
          </View>
          {showActionBar ? (
            <PostActionBar
              postId={post.id}
              replies={post.stats.replies}
              reposts={repostTotal}
              likes={post.stats.likes}
              liked={post.viewer?.liked}
              reposted={post.viewer?.reposted}
              bookmarked={post.viewer?.bookmarked}
              canReply={canReply}
              canRepost={canRepost}
              canBookmark={canBookmark}
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
function DetailMeta({ post, onCountPress }: { post: CardPost; onCountPress?: (tab: EngagementCountTab) => void }) {
  const date = post.createdAt;
  const when = `${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const counts = (
    [
      [post.stats.reposts, 'Repost', 'Reposts', 'reposts'],
      [post.stats.quotes, 'Quote', 'Quotes', 'quotes'],
      [post.stats.likes, 'Like', 'Likes', 'likes'],
    ] as const
  ).filter(([n]) => n > 0);
  return (
    <View className="mt-3 gap-3">
      <Text variant="subhead" tone="secondary">
        {when}
      </Text>
      {counts.length > 0 ? (
        <View className={cn('flex-row flex-wrap gap-x-4 gap-y-1 border-y py-3', tw.border)}>
          {counts.map(([n, one, many, tab]) => {
            const label = (
              <Text variant="subhead" tone="secondary">
                <Text variant="subheadStrong" tabular>
                  {formatNumber(n)}
                </Text>{' '}
                {n === 1 ? one : many}
              </Text>
            );
            return onCountPress ? (
              <Pressable
                key={tab}
                accessibilityRole="link"
                accessibilityLabel={`${formatNumber(n)} ${n === 1 ? one : many}`}
                hitSlop={hitSlopFor(20)}
                onPress={() => onCountPress(tab)}
                testID={`count-${tab}`}
              >
                {({ pressed }) => <View className={pressed ? 'opacity-60' : undefined}>{label}</View>}
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
