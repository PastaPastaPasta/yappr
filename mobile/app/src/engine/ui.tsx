import type { ReactNode } from 'react';
import { Pressable, Text as RNText, View } from 'react-native';

import { Text } from '~/ui/Text';

/**
 * The few pieces the engine screens (diagnostics, Lockdown, WebView update)
 * need until the design-system PR lands its Button and list rows.
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="mt-6">
      <Text variant="muted" className="mb-1 px-4 font-semibold uppercase tracking-wide">
        {title}
      </Text>
      <View className="border-y border-gray-200 dark:border-gray-800">{children}</View>
    </View>
  );
}

export function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  // Plain RN Text: ~/ui/Text's variants set a color that a tone class could not override.
  const color = {
    ok: 'text-green-600',
    warn: 'text-amber-600',
    bad: 'text-red-600',
    none: 'text-gray-900 dark:text-gray-100',
  }[tone ?? 'none'];
  return (
    <View className="flex-row items-start justify-between gap-4 px-4 py-2">
      <Text className="shrink-0">{label}</Text>
      <RNText selectable className={`flex-1 text-right font-mono text-sm ${color}`}>
        {value}
      </RNText>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  kind = 'primary',
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'outline' | 'danger' | 'plain';
  testID?: string;
}) {
  const box = {
    primary: 'bg-yappr-500',
    outline: 'border border-gray-300 dark:border-gray-700',
    danger: 'border border-red-500',
    plain: '',
  }[kind];
  const text = {
    primary: 'text-white',
    outline: 'text-gray-900 dark:text-white',
    danger: 'text-red-600',
    plain: 'text-yappr-500',
  }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={onPress}
      className={`items-center rounded-full px-5 py-3 active:opacity-70 ${box}`}
    >
      <RNText className={`text-base font-semibold ${text}`}>{label}</RNText>
    </Pressable>
  );
}
