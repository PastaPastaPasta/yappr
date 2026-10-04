import { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  ChatBubbleOvalLeftIcon,
  HeartIcon,
  ShareIcon,
} from 'react-native-heroicons/outline';
import {
  ArrowPathIcon as ArrowPathSolid,
  BookmarkIcon as BookmarkSolid,
  HeartIcon as HeartSolid,
} from 'react-native-heroicons/solid';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
} from 'react-native-reanimated';

import { cn, formatNumber } from '~/lib-allowlist';

import { Text } from '../Text';
import { lightImpact } from '../haptics';
import { useRipple } from '../ripple';
import { hitSlopFor, motion, useColors, useLargeText, type IconComponent } from '../tokens';

const ShareGlyph: IconComponent = Platform.OS === 'ios' ? ArrowUpTrayIcon : ShareIcon;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Reposts and quotes told apart, as the detail counts row shows them (`RepostQuoteCounts`). */
export interface RepostSplit {
  reposts: number;
  quotes: number;
  /** Floors read off a list that filled up: "100+ reposts". */
  truncated: boolean;
}

/** One count of a {@link RepostSplit} as the detail counts row shows it: "100+" is a floor. */
export interface RepostSplitPart {
  count: number;
  floor: '' | '+';
  kind: 'repost' | 'quote';
}

/**
 * The counts a screen reader should hear where the detail counts row tells
 * reposts and quotes apart; `null` where the single total says what the row
 * says (no split, or an exact one with no quotes). An exact split names
 * both ("0 reposts, 1 quote"); floors off a list that filled up leave a zero
 * out, as the row does ("100+ reposts", not "0+ quotes").
 */
export function repostSplitParts(split: RepostSplit | null | undefined): RepostSplitPart[] | null {
  if (!split || (split.quotes === 0 && !split.truncated)) return null;
  const floor = split.truncated ? '+' : '';
  const parts: RepostSplitPart[] = [
    { count: split.reposts, floor, kind: 'repost' },
    { count: split.quotes, floor, kind: 'quote' },
  ];
  const shown = split.truncated ? parts.filter((part) => part.count > 0) : parts;
  return shown.length > 0 ? shown : null;
}

/**
 * The repost control's label (UX_SPEC §5.13): "Repost or quote, {N} reposts",
 * and where the detail counts row tells quotes apart, the same split, so a
 * screen reader never hears "1 repost" beside a row reading "1 Quote"
 * (D-L4a-009). The viewer's own quote with text reads "quoted", a bare
 * repost (or a repost on contracts without quotes) "reposted".
 */
export function repostLabel(
  total: number,
  split: RepostSplit | null | undefined,
  state: { reposted: boolean; quoted: boolean },
): string {
  const parts = repostSplitParts(split);
  const counts = parts
    ? parts.map(({ count, floor, kind }) => `${count}${floor} ${count === 1 && !floor ? kind : `${kind}s`}`).join(', ')
    : plural(total, 'repost', 'reposts');
  const mark = state.reposted ? (state.quoted ? ', quoted' : ', reposted') : '';
  return `Repost or quote, ${counts}${mark}`;
}

interface ActionProps {
  icon: IconComponent;
  activeIcon?: IconComponent;
  active?: boolean;
  /** The active color token. */
  tone?: 'like' | 'repost' | 'link';
  count?: number;
  showCount: boolean;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** Not usable yet (the viewer's marks are loading): disabled, with a spinner in place of the icon. */
  busy?: boolean;
  /** Spring the icon when it turns on (the like heart). */
  bounce?: boolean;
  testID: string;
}

function Action({
  icon: Icon,
  activeIcon: ActiveIcon = Icon,
  active = false,
  tone = 'link',
  count,
  showCount,
  label,
  onPress,
  disabled: disabledProp,
  busy = false,
  bounce = false,
  testID,
}: ActionProps) {
  const disabled = disabledProp || busy;
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Keyed by test id (which carries the post id), so a recycled cell showing
  // another, already-liked post doesn't spring.
  const last = useRef({ testID, active });

  useEffect(() => {
    // Only a change to "on" of the same post springs.
    const turnedOn = last.current.testID === testID && !last.current.active && active;
    if (bounce && turnedOn && !reduceMotion) {
      scale.set(withSequence(withSpring(0.8, motion.springLike), withSpring(1, motion.springLike)));
    }
    last.current = { testID, active };
  }, [active, bounce, reduceMotion, scale, testID]);

  const color = active ? c[tone] : c.textSecondary;
  const Glyph = active ? ActiveIcon : Icon;

  const ripple = useRipple('icon');
  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled, busy }}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      hitSlop={hitSlopFor(44)}
      // 44 pt tall, padded beside the 20 pt icon (UX_SPEC §6.4).
      className={cn(
        'min-h-11 min-w-11 flex-row items-center gap-1 rounded-full px-2',
        disabled && 'opacity-50',
      )}
    >
      <Animated.View style={style}>
        {busy ? (
          <ActivityIndicator size="small" color={c.textSecondary} style={{ width: 20, height: 20 }} />
        ) : (
          <Glyph size={20} color={color} />
        )}
      </Animated.View>
      {showCount && count ? (
        <Text variant="subhead" tabular style={{ color }}>
          {formatNumber(count)}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface PostActionBarProps {
  postId: string;
  replies: number;
  /** Reposts plus quotes: the repost control counts both (web `totalReposts`). */
  reposts: number;
  /** Detail only: `reposts` split as the counts row shows it; the label follows it. */
  repostSplit?: RepostSplit | null;
  likes: number;
  liked?: boolean;
  reposted?: boolean;
  /** The viewer's repost is their own quote with text (`viewer.ownQuoteId`, not bare). */
  quoted?: boolean;
  bookmarked?: boolean;
  /** Private posts take no replies or quotes (PRD POST-08). */
  canReply?: boolean;
  /** From engine capabilities for the post's kind (`canRepost(kind)`). */
  canRepost?: boolean;
  /** From engine capabilities for the post's kind (`canBookmark(kind)`). */
  canBookmark?: boolean;
  /**
   * The viewer's like, repost and bookmark marks are still loading (a bare
   * repost's target): those buttons show a spinner and take no taps until
   * they are known (acting on a guess would send a duplicate).
   */
  marksLoading?: boolean;
  onReply?: () => void;
  onRepost?: () => void;
  onLike?: () => void;
  onBookmark?: () => void;
  onShare?: () => void;
}

/** Fires the like haptic on "on" only (UX_SPEC §1.9). */
function withLikeHaptic(liked: boolean, onLike?: () => void) {
  if (!onLike) return undefined;
  return () => {
    if (!liked) lightImpact();
    onLike();
  };
}

/**
 * Reply, repost, like, then bookmark and share (UX_SPEC §2.4.9, web
 * post-action-bar.tsx). Counts are blank at 0 and move into the labels at
 * accessibility text sizes; active actions switch to the solid icon.
 */
export function PostActionBar({
  postId,
  replies,
  reposts,
  repostSplit,
  likes,
  liked = false,
  reposted = false,
  quoted = false,
  bookmarked = false,
  canReply = true,
  canRepost = true,
  canBookmark = true,
  marksLoading = false,
  onReply,
  onRepost,
  onLike,
  onBookmark,
  onShare,
}: PostActionBarProps) {
  const showCount = !useLargeText();

  return (
    <View className="-ml-2 mt-1 max-w-[485px] flex-row items-center" testID={`action-bar-${postId}`}>
      <View className="flex-1 flex-row items-center justify-between pr-4">
        {canReply ? (
          <Action
            icon={ChatBubbleOvalLeftIcon}
            count={replies}
            showCount={showCount}
            label={`Reply, ${plural(replies, 'reply', 'replies')}`}
            onPress={onReply}
            testID={`reply-btn-${postId}`}
          />
        ) : (
          <View className="min-w-11" />
        )}
        {canRepost ? (
          <Action
            icon={ArrowPathIcon}
            activeIcon={ArrowPathSolid}
            active={reposted}
            tone="repost"
            count={reposts}
            showCount={showCount}
            label={repostLabel(reposts, repostSplit, { reposted, quoted })}
            onPress={onRepost}
            busy={marksLoading}
            testID={`repost-btn-${postId}`}
          />
        ) : (
          <View className="min-w-11" />
        )}
        <Action
          icon={HeartIcon}
          activeIcon={HeartSolid}
          active={liked}
          tone="like"
          bounce
          count={likes}
          showCount={showCount}
          label={`${liked ? 'Unlike' : 'Like'}, ${plural(likes, 'like', 'likes')}`}
          onPress={withLikeHaptic(liked, onLike)}
          busy={marksLoading}
          testID={`like-btn-${postId}`}
        />
      </View>
      <View className="flex-row items-center gap-2">
        {canBookmark ? (
          <Action
            icon={BookmarkIcon}
            activeIcon={BookmarkSolid}
            active={bookmarked}
            showCount={false}
            label={bookmarked ? 'Remove bookmark' : 'Bookmark'}
            onPress={onBookmark}
            busy={marksLoading}
            testID={`bookmark-btn-${postId}`}
          />
        ) : null}
        <Action
          icon={ShareGlyph}
          showCount={false}
          label="Share"
          onPress={onShare}
          testID={`share-btn-${postId}`}
        />
      </View>
    </View>
  );
}
