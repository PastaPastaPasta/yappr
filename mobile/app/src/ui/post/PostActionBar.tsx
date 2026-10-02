import { useEffect, useRef } from 'react';
import { Platform, Pressable, View } from 'react-native';
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
  disabled,
  bounce = false,
  testID,
}: ActionProps) {
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
      accessibilityState={{ selected: active, disabled: !!disabled }}
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
        <Glyph size={20} color={color} />
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
  likes: number;
  liked?: boolean;
  reposted?: boolean;
  bookmarked?: boolean;
  /** Private posts take no replies or quotes (PRD POST-08). */
  canReply?: boolean;
  /** From engine capabilities for the post's kind (`canRepost(kind)`). */
  canRepost?: boolean;
  /** From engine capabilities for the post's kind (`canBookmark(kind)`). */
  canBookmark?: boolean;
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
  likes,
  liked = false,
  reposted = false,
  bookmarked = false,
  canReply = true,
  canRepost = true,
  canBookmark = true,
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
            label={`Repost or quote, ${plural(reposts, 'repost', 'reposts')}${reposted ? ', reposted' : ''}`}
            onPress={onRepost}
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
