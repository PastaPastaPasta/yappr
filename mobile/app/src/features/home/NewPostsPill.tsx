import type { PostDTO } from '@engine/api';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { ArrowUpIcon } from 'react-native-heroicons/outline';
import Animated, { FadeOut, Keyframe } from 'react-native-reanimated';

import { Avatar } from '~/ui/Avatar';
import { ScalePressable } from '~/ui/ScalePressable';
import { Text } from '~/ui/Text';
import { colors, motion } from '~/ui/tokens';

/** UX_SPEC §5.2. */
export function newPostsLabel(count: number): string {
  return count === 1 ? 'Show 1 new post' : `Show ${count} new posts`;
}

/** In: from 20 pt above, fading in (`spring.pill`); out: fade. Reanimated skips both under Reduce Motion. */
const ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -20 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
}).duration(motion.slow);
const EXIT = FadeOut.duration(motion.fast);

/** Up to three newest authors, each once. */
function newestAuthors(posts: readonly PostDTO[]) {
  const seen = new Set<string>();
  const authors: PostDTO['author'][] = [];
  for (const post of posts) {
    if (seen.has(post.author.id)) continue;
    seen.add(post.author.id);
    authors.push(post.author);
    if (authors.length === 3) break;
  }
  return authors;
}

export interface NewPostsPillProps {
  posts: readonly PostDTO[];
  onPress: () => void;
}

/**
 * "Show N new posts" (UX_SPEC §2.20, PRD FEED-05): floats 12 pt under the
 * feed's top edge, over the list, which does not move until it is tapped.
 */
export function NewPostsPill({ posts, onPress }: NewPostsPillProps) {
  const count = posts.length;
  const label = newPostsLabel(count);
  const visible = count > 0;

  // Announced once when it appears, not on every count change.
  const announced = useRef(false);
  useEffect(() => {
    if (!visible) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    AccessibilityInfo.announceForAccessibility(label);
  }, [visible, label]);

  if (!visible) return null;
  const authors = newestAuthors(posts);

  return (
    <View pointerEvents="box-none" className="absolute left-0 right-0 top-3 z-10 items-center">
      <Animated.View entering={ENTER} exiting={EXIT}>
        <ScalePressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          testID="new-posts-pill"
          className="h-9 flex-row items-center gap-1.5 rounded-full bg-yappr-600 pl-3 pr-4 shadow-lg active:bg-yappr-700 dark:bg-yappr-500 dark:active:bg-yappr-600"
        >
          <ArrowUpIcon size={14} color={colors.white} strokeWidth={2.5} />
          <View className="flex-row" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {authors.map((author, index) => (
              <View
                key={author.id}
                className="rounded-full border-2 border-yappr-600 dark:border-yappr-500"
                style={{ marginLeft: index === 0 ? 0 : -8, zIndex: 3 - index }}
              >
                <Avatar avatar={author.avatar} identityId={author.id} size="xs" />
              </View>
            ))}
          </View>
          <Text variant="buttonSm" tone="inverse" maxFontSizeMultiplier={1.5}>
            {label}
          </Text>
        </ScalePressable>
      </Animated.View>
    </View>
  );
}
