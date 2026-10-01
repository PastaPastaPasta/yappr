import { memo, useState, type ReactNode } from 'react';
import { Pressable, View, type AccessibilityActionEvent } from 'react-native';
import { ArrowPathIcon, EllipsisHorizontalIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { cn, formatNumber, formatTime, truncateId } from '~/lib-allowlist';

import { Avatar } from '../Avatar';
import { handleOf } from '../handle';
import { IconButton } from '../IconButton';
import { LinkText } from '../LinkText';
import { RichText, type RichTextHandlers } from '../rich-text/RichText';
import { Skeleton } from '../Skeleton';
import { Text } from '../Text';
import { monoFont, tw, useColors, useLargeText } from '../tokens';
import { useRelativeTime } from '../use-relative-time';
import { WriteStatus, writeStatusLinks, type WriteStatusProps } from '../WriteStatus';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MediaGrid } from './MediaGrid';
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
  /** The context menu (S5): iOS UIContextMenu, Android sheet. */
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
  /** The optimistic variant's write status. */
  writeStatus?: WriteStatusProps;
  tagMaxLength?: number;
  actions?: PostCardActions;
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
  time,
  pending,
  showMore,
  actions,
}: {
  post: CardPost;
  time: string;
  pending: boolean;
  showMore: boolean;
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
    <Text variant="subhead" tone="secondary" className="shrink-0">
      · {time}
    </Text>
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
      {showMore ? (
        <IconButton
          icon={EllipsisHorizontalIcon}
          accessibilityLabel={post.kind === 'reply' ? 'Reply options' : 'Post options'}
          onPress={actions.onMore}
          testID={`more-btn-${post.id}`}
          className="-my-1.5 -mr-2"
        />
      ) : null}
    </View>
  );
}

/** The screen-reader summary of a card (UX_SPEC §6.2). */
function postAccessibilityLabel(
  post: CardPost,
  extras: { repostedBy?: string; replyingTo?: string; quoteCovered: boolean },
): string {
  // The spoken form ("5 minutes ago"): "5m" reads as "5 meters".
  const parts = [`${post.author.displayName}, ${handleOf(post.author)}, ${formatTime(post.createdAt)}.`];
  if (extras.repostedBy) parts.push(`Reposted by ${extras.repostedBy}.`);
  if (extras.replyingTo) parts.push(`Replying to @${extras.replyingTo}.`);
  if (post.deleted) parts.push(stubText('deleted', post.kind));
  else if (post.encrypted) parts.push('Private post.');
  else if (post.content) parts.push(`${post.content}.`);
  const { quoted } = post;
  if (quoted) {
    const hidden = extras.quoteCovered || quoted.encrypted || quoted.deleted;
    parts.push(`Quote: ${quoted.author.displayName}${hidden ? '' : `, ${quoted.content}`}.`);
  }
  for (const media of post.media) parts.push(`Image: ${media.alt || 'image'}.`);
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
  actions = {},
}: PostCardProps) {
  const time = useRelativeTime(post.createdAt);
  const [revealed, reveal] = useSensitiveReveal(post.id);
  // Whether the feed text overflowed, keyed by post so a recycled cell re-measures.
  const [clampedId, setClampedId] = useState<string>();
  const clamped = clampedId === post.id;

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
    if (post.quoted) {
      quoteSlot = (
        <QuoteEmbed
          post={post.quoted}
          nsfwGated={quoteNsfwGated ?? post.quoted.sensitive}
          mediaGated={quoteMediaGated}
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
        {post.content ? (
          <View className="mt-0.5">
            <RichText
              text={post.content}
              variant={detail ? 'bodyLarge' : 'body'}
              numberOfLines={clamped ? FEED_MAX_LINES : undefined}
              hideFirstUrl={linkPreview !== undefined && linkPreview !== 'error'}
              tagMaxLength={tagMaxLength}
              onTextLayout={
                variant === 'feed' && !clamped
                  ? (e) => {
                      if (e.nativeEvent.lines.length > FEED_MAX_LINES) setClampedId(post.id);
                    }
                  : undefined
              }
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
        {detail ? <DetailMeta post={post} /> : null}
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
    if (variant === 'optimistic' && writeStatus) {
      for (const link of writeStatusLinks(writeStatus))
        a11yActions.push({ name: link.label, label: link.label, run: link.onPress });
    }
    if (mediaGated && post.media.length > 0)
      a11yActions.push({ name: 'showMedia', label: 'Show media', run: onRevealMedia });
  }
  a11yActions.push(
    { name: 'profile', label: 'Open profile', run: actions.onAuthorPress },
    { name: 'more', label: 'More', run: variant === 'compact' ? undefined : actions.onMore },
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
              repostedBy: reposter,
              replyingTo,
              quoteCovered: (quoteNsfwGated ?? post.quoted?.sensitive) === true,
            })
      }
      accessibilityActions={available.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={onAccessibilityAction}
      onPress={actions.onPress}
      onLongPress={actions.onLongPress}
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
            time={time}
            pending={authorPending}
            showMore={variant !== 'compact' && !!actions.onMore}
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
          {variant === 'optimistic' && writeStatus ? <WriteStatus {...writeStatus} /> : null}
        </View>
      </View>
    </Pressable>
  );
});

/** Detail only: the absolute time and the counts row (UX_SPEC §2.4.4). */
function DetailMeta({ post }: { post: CardPost }) {
  const date = post.createdAt;
  const when = `${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const counts = [
    [post.stats.reposts, 'Repost', 'Reposts'],
    [post.stats.quotes, 'Quote', 'Quotes'],
    [post.stats.likes, 'Like', 'Likes'],
  ] as const;
  return (
    <View className="mt-3 gap-3">
      <Text variant="subhead" tone="secondary">
        {when}
      </Text>
      <View className={cn('flex-row flex-wrap gap-x-4 gap-y-1 border-y py-3', tw.border)}>
        {counts.map(([n, one, many]) => (
          <Text key={many} variant="subhead" tone="secondary">
            <Text variant="subheadStrong" tabular>
              {formatNumber(n)}
            </Text>{' '}
            {n === 1 ? one : many}
          </Text>
        ))}
      </View>
    </View>
  );
}
