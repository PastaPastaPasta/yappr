import { Pressable, View } from 'react-native';
import { BookOpenIcon, ChevronRightIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { MIN_TARGET, tw, useColors } from '~/ui/tokens';

import { openBlogs } from './blog-navigation';

/** Explore's way into blogs (web's sidebar "Blog" link). */
export function BlogsLink() {
  const c = useColors();
  return (
    <Pressable
      onPress={openBlogs}
      accessibilityRole="button"
      accessibilityLabel="Blogs. Longer posts from Yappr writers"
      className={cn('flex-row items-center gap-3 rounded-xl border px-3 active:bg-gray-50 dark:active:bg-gray-950', tw.border)}
      style={{ minHeight: MIN_TARGET + 8 }}
      testID="explore-blogs"
    >
      <BookOpenIcon size={22} color={c.accent} />
      <View className="flex-1">
        <Text variant="bodyStrong">Blogs</Text>
        <Text variant="caption" tone="secondary">Longer posts from Yappr writers</Text>
      </View>
      <ChevronRightIcon size={18} color={c.textSecondary} />
    </Pressable>
  );
}
