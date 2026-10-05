import { useImperativeHandle, type Ref } from 'react';
import { Platform, Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { MagnifyingGlassIcon, XCircleIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { INPUT_SLOT, InputSlot } from '~/ui/InputSlot';
import { useNativeText, type TextResetHandle } from '~/ui/native-text';
import { Text } from '~/ui/Text';
import { hitSlopFor, tw, useColors } from '~/ui/tokens';

export const SEARCH_PLACEHOLDER = 'Search Yappr';

const SEARCH_TEXT = { fontSize: 16, minHeight: 36, paddingVertical: 0 } as const;

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
  /** `reset(text)`: sets the search for an action of the user's (a recent search), before `value` follows. */
  ref?: Ref<TextResetHandle>;
}

/**
 * The live search field, with its clear button while there is text.
 * Uncontrolled (`useNativeText`), so no keystroke is lost while results
 * load; Clear and a recent search tapped are put in.
 */
export function SearchField({ value, onChangeText, ref, onFocus, onBlur, autoFocus, ...props }: SearchFieldProps) {
  const c = useColors();
  const { key: inputKey, attach, reset, inputProps, retiring } = useNativeText({ value, onChangeText, onFocus, onBlur, autoFocus });
  useImperativeHandle(ref, () => ({ reset }), [reset]);
  /** The live input and the one a reset replaced: the same input, but for its handlers, text and test id. */
  const field = (fieldProps: TextInputProps, live: boolean) => (
    <TextInput
      ref={live ? attach : undefined}
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
      className="text-gray-900 dark:text-gray-100"
      // fontSize without a lineHeight: iOS mis-lays out single-line inputs with one.
      style={SEARCH_TEXT}
      testID={live ? 'search-input' : undefined}
      {...props}
      {...fieldProps}
    />
  );
  return (
    <View className={cn(FIELD, 'flex-1')}>
      <MagnifyingGlassIcon size={16} color={c.textSecondary} />
      {retiring ? (
        // The input a reset replaced, until the fresh one has the focus: hidden by its slot alone.
        <InputSlot key={retiring.key} retired>
          {field(retiring.inputProps, false)}
        </InputSlot>
      ) : null}
      <InputSlot key={inputKey} style={INPUT_SLOT}>
        {field(inputProps, true)}
      </InputSlot>
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={hitSlopFor(20)}
          onPress={() => {
            reset('');
            onChangeText('');
          }}
          testID="search-clear"
        >
          <XCircleIcon size={18} color={c.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}
