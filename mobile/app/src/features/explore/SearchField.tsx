import type { Ref } from 'react';
import { Platform, Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { hitSlopFor, tw, useColors } from '~/ui/tokens';

export const SEARCH_PLACEHOLDER = 'Search Yappr';

/** UX_SPEC §2.11: 36 high, `bg.muted`, the UISearchBar's rounded rect on iOS and a pill on Android. */
const FIELD = cn('min-h-9 flex-row items-center gap-2 px-2.5', tw.bgMuted, Platform.OS === 'ios' ? 'rounded-[10px]' : 'rounded-full px-3.5');

/**
 * Explore's search field, as a button: tapping it opens the search screen
 * with the keyboard up (iOS: the search bar's results-controller pattern).
 */
export function SearchLauncher({ onPress }: { onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={SEARCH_PLACEHOLDER}
      accessibilityHint="Opens search"
      onPress={onPress}
      testID="explore-search"
      className={FIELD}
    >
      <MagnifyingGlassIcon size={16} color={c.textSecondary} />
      <Text variant="body" tone="placeholder" numberOfLines={1} className="flex-1">
        {SEARCH_PLACEHOLDER}
      </Text>
    </Pressable>
  );
}

export interface SearchFieldProps extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  value: string;
  onChangeText: (text: string) => void;
  ref?: Ref<TextInput>;
}

/** The live search field, with its clear button while there is text. */
export function SearchField({ value, onChangeText, ref, ...props }: SearchFieldProps) {
  const c = useColors();
  return (
    <View className={cn(FIELD, 'flex-1')}>
      <MagnifyingGlassIcon size={16} color={c.textSecondary} />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={SEARCH_PLACEHOLDER}
        placeholderTextColor={c.textPlaceholder}
        accessibilityLabel={SEARCH_PLACEHOLDER}
        accessibilityRole="search"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="search"
        enablesReturnKeyAutomatically
        cursorColor={c.accent}
        selectionColor={c.accent}
        className="flex-1 text-gray-900 dark:text-gray-100"
        // fontSize without a lineHeight: iOS mis-lays out single-line inputs with one.
        style={{ fontSize: 16, minHeight: 36, paddingVertical: 0 }}
        testID="search-input"
        {...props}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={hitSlopFor(20)}
          onPress={() => onChangeText('')}
          testID="search-clear"
        >
          <XCircleIcon size={18} color={c.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}
