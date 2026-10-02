import { memo, useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRightIcon } from 'react-native-heroicons/outline';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { PostItem } from '~/features/post/PostItem';
import { openPost } from '~/features/post/post-navigation';
import { cn } from '~/lib-allowlist';
import { ErrorState } from '~/ui/EmptyState';
import { PostStub } from '~/ui/post/PostStub';
import { PostSkeleton } from '~/ui/Skeleton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

import type { ThreadRow } from './thread-rows';

/**
 * The thread line's x: the 48 pt avatar's center inside the card's 16 pt
 * padding, less half the 2 pt line.
 */
const LINE_LEFT = 16 + 24 - 1;
/** Where a card's avatar ends: 12 pt top padding + 48 pt avatar + a 4 pt gap. */
const BELOW_AVATAR = 12 + 48 + 4;
/** Where a card's avatar starts, less a 2 pt gap. */
const ABOVE_AVATAR = 10;
/** Nested replies sit one indent in, past a 2 pt rule (web `ml-12 border-l-2`). */
const INDENT = 'ml-12 border-l-2 border-gray-200 dark:border-gray-700';

/** The vertical line that joins a post to the one above or below it in a thread. */
function ThreadLine({ position }: { position: 'above' | 'below' }) {
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      className="absolute w-0.5 bg-gray-300 dark:bg-gray-600"
      style={
        position === 'above'
          ? { left: LINE_LEFT, top: 0, height: ABOVE_AVATAR }
          : { left: LINE_LEFT, top: BELOW_AVATAR, bottom: 0 }
      }
    />
  );
}

/** A `?reply=` target: a tint that fades once the list has scrolled to it. */
function Highlight() {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!reduceMotion) opacity.set(withDelay(1600, withTiming(0, { duration: 1200 })));
  }, [opacity, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, style]}>
      <View className="flex-1 bg-yappr-50 dark:bg-yappr-950/60" />
    </Animated.View>
  );
}

function AuthorThreadLabel() {
  const c = useColors();
  return (
    <View className="flex-row items-center gap-1.5 px-4 pb-0 pt-2" style={{ paddingLeft: 16 + 48 + 12 }}>
      <View className="h-1.5 w-1.5 rounded-full bg-yappr-500" />
      {/* The web's yappr-500 in both themes; a className would lose to Text's own tone. */}
      <Text variant="captionStrong" style={{ color: c.accent }}>
        Author thread
      </Text>
    </View>
  );
}

function ContinueThread({ replyId, count }: { replyId: string; count: number }) {
  const c = useColors();
  const more = `${count} more ${count === 1 ? 'reply' : 'replies'}`;
  return (
    <View className={INDENT}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Continue thread, ${more}`}
        onPress={() => openPost(replyId)}
        testID={`continue-thread-${replyId}`}
        className={cn('min-h-11 flex-row items-center gap-1.5 py-3 pr-4', tw.pressed)}
        style={{ paddingLeft: 16 + 48 + 12 }}
      >
        <Text variant="subheadStrong" style={{ color: c.accent }}>
          Continue thread
        </Text>
        <Text variant="subhead" tone="secondary">
          · {more}
        </Text>
        <ChevronRightIcon size={16} color={c.textSecondary} />
      </Pressable>
    </View>
  );
}

function RepliesLoading() {
  return (
    <View className="items-center gap-2 p-6" testID="replies-loading">
      <Spinner size="sm" />
      <Text variant="subhead" tone="secondary">
        Loading replies…
      </Text>
    </View>
  );
}

function RepliesEmpty() {
  return (
    <View className="items-center p-8" testID="replies-empty">
      <Text variant="body" tone="secondary" className="text-center">
        No replies yet. Be the first to reply!
      </Text>
    </View>
  );
}

/** One row of the post detail list. */
export const ThreadRowView = memo(function ThreadRowView({
  row,
  onRetryReplies,
}: {
  row: ThreadRow;
  onRetryReplies: () => void;
}) {
  switch (row.type) {
    case 'ancestor':
      return (
        <View testID={`ancestor-${row.post.id}`}>
          {row.post.deleted ? (
            <PostStub state="deleted" kind={row.post.kind} variant="card" />
          ) : (
            <PostItem post={row.post} variant="compact" />
          )}
          <ThreadLine position="below" />
        </View>
      );
    case 'ancestorStub':
      return <PostStub state="unavailable" kind={row.kind} testID={`ancestor-stub-${row.id}`} />;
    case 'focus':
      return (
        <View testID="thread-focus">
          {row.lineAbove ? <ThreadLine position="above" /> : null}
          <PostItem post={row.post} variant="detail" replyingTo={row.replyingTo} />
        </View>
      );
    case 'focusStub':
      return <PostStub state={row.state} kind={row.kind} testID="thread-focus-stub" />;
    case 'focusSkeleton':
      return <PostSkeleton />;
    case 'reply': {
      const { reply } = row;
      // A reply proved deleted (a v10 stand-in or a tombstone) keeps its place as a stub (PRD POST-04).
      const card = reply.deletedStub || reply.deleted ? (
        <PostStub state="deleted" kind="reply" testID={`reply-stub-${reply.id}`} />
      ) : (
        <PostItem post={reply} replyingTo={row.replyingTo} />
      );
      return (
        <View testID={`thread-reply-${reply.id}`} className={reply.depth === 1 ? INDENT : undefined}>
          {row.highlighted ? <Highlight /> : null}
          {row.authorThreadStart ? <AuthorThreadLabel /> : null}
          <View>
            {row.lineAbove ? <ThreadLine position="above" /> : null}
            {card}
            {row.lineBelow ? <ThreadLine position="below" /> : null}
          </View>
        </View>
      );
    }
    case 'continue':
      return <ContinueThread replyId={row.replyId} count={row.count} />;
    case 'repliesLoading':
      return <RepliesLoading />;
    case 'repliesEmpty':
      return <RepliesEmpty />;
    case 'repliesError':
      return <ErrorState message={row.message} onRetry={onRetryReplies} testID="replies-error" />;
  }
});
