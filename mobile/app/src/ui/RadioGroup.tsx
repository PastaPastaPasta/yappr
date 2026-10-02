import { Platform, Pressable, View } from 'react-native';
import { CheckIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { Text } from './Text';
import { useRipple } from './ripple';
import { tw, useColors } from './tokens';

export interface RadioOption<T extends string> {
  value: T;
  title: string;
  description?: string;
}

export interface RadioGroupProps<T extends string> {
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Read out as the group's name. */
  accessibilityLabel?: string;
  testID?: string;
}

/** A Material radio: a 20 dp ring, filled in the middle when selected. */
function RadioCircle({ selected }: { selected: boolean }) {
  return (
    <View
      className={cn(
        'h-5 w-5 items-center justify-center rounded-full border-2',
        selected ? 'border-yappr-500' : 'border-gray-500 dark:border-gray-400',
      )}
    >
      {selected ? <View className="h-2.5 w-2.5 rounded-full bg-yappr-500" /> : null}
    </View>
  );
}

/**
 * Option rows for NSFW mode, theme and the like (UX_SPEC §2.9): a trailing
 * check mark on iOS, a leading Material radio on Android. Each row has a
 * title and an optional description.
 */
export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  testID,
}: RadioGroupProps<T>) {
  const c = useColors();
  const ios = Platform.OS === 'ios';

  const ripple = useRipple();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} testID={testID}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            android_ripple={ripple}
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.title}
            accessibilityState={{ checked: selected }}
            accessibilityHint={option.description}
            onPress={() => onChange(option.value)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            className={cn(
              'min-h-14 flex-row items-center gap-3 px-4 py-3',
              tw.pressed,
              index > 0 && cn('border-t', tw.border),
            )}
          >
            {ios ? null : <RadioCircle selected={selected} />}
            <View className="flex-1 gap-0.5">
              <Text variant="body">{option.title}</Text>
              {option.description ? (
                <Text variant="subhead" tone="secondary">
                  {option.description}
                </Text>
              ) : null}
            </View>
            {ios && selected ? <CheckIcon size={20} color={c.accent} strokeWidth={2.5} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
