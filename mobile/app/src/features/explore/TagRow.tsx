import type { TagDTO } from '@engine/api';
import { Pressable, View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { tw } from '~/ui/tokens';

import { tagCountLabel } from './tags';

export interface TagRowProps {
  tag: TagDTO;
  /** The trending position; search rows have none. */
  rank?: number;
  onPress: (tag: TagDTO) => void;
  testID?: string;
}

/** A trending or search tag (UX_SPEC §4.15): rank caption, `#tag` or `$TAG`, and its count. */
export function TagRow({ tag, rank, onPress, testID }: TagRowProps) {
  const count = tagCountLabel(tag);
  const ripple = useRipple();
  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={[rank !== undefined && `Number ${rank}`, tag.display, count].filter(Boolean).join(', ')}
      onPress={() => onPress(tag)}
      testID={testID}
      className={cn('min-h-16 flex-row items-center gap-3 px-4 py-3', tw.pressed)}
    >
      {rank !== undefined ? (
        <Text variant="subhead" tone="secondary" tabular className="w-6 text-right">
          {rank}
        </Text>
      ) : null}
      <View className="flex-1">
        <Text variant="bodyStrong" tone="link" numberOfLines={1}>
          {tag.display}
        </Text>
        <Text variant="subhead" tone="secondary">
          {count}
        </Text>
      </View>
    </Pressable>
  );
}
