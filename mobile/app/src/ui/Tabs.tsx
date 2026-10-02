import NativeSegmentedControl from '@react-native-segmented-control/segmented-control';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { CheckIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { CountBadge } from './Badge';
import { selectionTick } from './haptics';
import { Text } from './Text';
import { useRipple } from './ripple';
import { hitSlopFor, tw, useColors } from './tokens';

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}

/** Every tab, segment and chip change ticks (UX_SPEC §1.9). */
function select<T extends string>(next: T, current: T, onChange: (value: T) => void) {
  if (next === current) return;
  selectionTick();
  onChange(next);
}

/**
 * Underlined top tabs (Home For You / Following, profile tabs, engagements):
 * equal-width labels, a 4 pt `accent` bar 56 wide under the active one.
 */
export function TopTabs<T extends string>({ options, value, onChange, testID }: SelectProps<T>) {
  const ripple = useRipple();
  return (
    <View accessibilityRole="tablist" testID={testID} className={cn('flex-row border-b', tw.border)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            android_ripple={ripple}
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => select(option.value, value, onChange)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            className={cn('min-h-12 flex-1 items-center justify-center pt-3', tw.pressed)}
          >
            <Text
              variant="subheadStrong"
              tone={active ? 'emphasis' : 'secondary'}
              maxFontSizeMultiplier={1.5}
            >
              {option.label}
            </Text>
            <View
              className={cn('mt-2.5 h-1 w-14 rounded-full', active ? 'bg-yappr-500' : 'bg-transparent')}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Recent / Top, window toggles and other mutually exclusive segments: the
 * native `UISegmentedControl` on iOS, Material 3 outlined segmented buttons
 * on Android (UX_SPEC §2.8).
 */
export function SegmentedControl<T extends string>({ options, value, onChange, testID }: SelectProps<T>) {
  const c = useColors();
  const ripple = useRipple();
  if (Platform.OS === 'ios') {
    return (
      <NativeSegmentedControl
        testID={testID}
        values={options.map((o) => o.label)}
        selectedIndex={Math.max(
          0,
          options.findIndex((o) => o.value === value),
        )}
        onChange={(e) => {
          const next = options[e.nativeEvent.selectedSegmentIndex];
          if (next) select(next.value, value, onChange);
        }}
      />
    );
  }
  return (
    <View
      accessibilityRole="tablist"
      testID={testID}
      className={cn('flex-row overflow-hidden rounded-full border', tw.borderStrong)}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <Pressable
            android_ripple={ripple}
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => select(option.value, value, onChange)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            hitSlop={hitSlopFor(40)}
            className={cn(
              'min-h-10 flex-1 flex-row items-center justify-center gap-1.5 px-3',
              index > 0 && cn('border-l', tw.borderStrong),
              active ? tw.bgSelected : tw.pressedMuted,
            )}
          >
            {active ? <CheckIcon size={16} color={c.textPrimary} /> : null}
            <Text variant="subheadStrong" maxFontSizeMultiplier={1.5}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface FilterChipOption<T extends string> extends TabOption<T> {
  /** Unread count shown as a badge after the label. */
  count?: number;
}

/** Notification filters: a horizontal row of 32 pt pills (UX_SPEC §2.8). */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  testID,
}: Omit<SelectProps<T>, 'options'> & { options: readonly FilterChipOption<T>[] }) {
  const ripple = useRipple();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 py-2"
      testID={testID}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            android_ripple={ripple}
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            hitSlop={hitSlopFor(32)}
            onPress={() => select(option.value, value, onChange)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            className={cn(
              'h-8 flex-row items-center gap-1.5 rounded-full border px-3 android:overflow-hidden',
              active ? cn(tw.bgSelected, 'border-yappr-500') : cn(tw.bgMuted, 'border-transparent'),
            )}
          >
            <Text variant="subhead" tone={active ? 'link' : 'primary'} maxFontSizeMultiplier={1.5}>
              {option.label}
            </Text>
            {option.count ? <CountBadge count={option.count} /> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
