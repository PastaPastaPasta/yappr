import type { ReactNode } from 'react';
import { Pressable, Text as RNText, View } from 'react-native';

import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';

import { useLeaveWhenEngineRecovers } from './hooks';
import { engineSupervisor } from './index';

/**
 * The few pieces the engine screens (diagnostics, Lockdown, WebView update)
 * need until the design-system PR lands its Button and list rows.
 */

export type Tone = 'ok' | 'warn' | 'bad';

// Plain RN Text below: ~/ui/Text's variants set a color that these classes could not override.
const TONE_COLOR: Record<Tone | 'none', string> = {
  ok: 'text-green-600',
  warn: 'text-amber-600',
  bad: 'text-red-600',
  none: 'text-gray-900 dark:text-gray-100',
};

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="mt-6">
      <Text variant="captionStrong" tone="secondary" className="mb-1 px-4 uppercase tracking-wide">
        {title}
      </Text>
      <View className="border-y border-gray-200 dark:border-gray-800">{children}</View>
    </View>
  );
}

export function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <View className="flex-row items-start justify-between gap-4 px-4 py-2">
      <Text className="shrink-0">{label}</Text>
      <RNText selectable className={`flex-1 text-right font-mono text-sm ${TONE_COLOR[tone ?? 'none']}`}>
        {value}
      </RNText>
    </View>
  );
}

type ButtonKind = 'primary' | 'outline' | 'danger' | 'plain';

const BUTTON_STYLE: Record<ButtonKind, { box: string; text: string }> = {
  primary: { box: 'bg-yappr-500', text: 'text-white' },
  outline: { box: 'border border-gray-300 dark:border-gray-700', text: 'text-gray-900 dark:text-white' },
  danger: { box: 'border border-red-500', text: 'text-red-600' },
  plain: { box: '', text: 'text-yappr-500' },
};

export function ActionButton({
  label,
  onPress,
  kind = 'primary',
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  testID?: string;
}) {
  const { box, text } = BUTTON_STYLE[kind];
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

/**
 * The Lockdown and WebView update screens: why the engine cannot run here,
 * what to do about it, and the ways out every such screen has (browse saved
 * content, try again). It leaves by itself once the engine recovers.
 */
export function EngineUnavailableScreen({
  icon,
  title,
  body,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  /** Extra content between the body and the buttons (Lockdown's steps). */
  children?: ReactNode;
  action: { label: string; onPress: () => void };
}) {
  const leave = useLeaveWhenEngineRecovers();
  return (
    <Screen scroll>
      <View className="flex-1 items-center gap-5 px-8 pb-12 pt-24">
        {icon}
        <Text variant="titleLarge" className="text-center">
          {title}
        </Text>
        <Text tone="secondary" className="text-center">
          {body}
        </Text>
        {children}
        <View className="gap-3 self-stretch pt-2">
          <ActionButton label={action.label} onPress={action.onPress} />
          <ActionButton kind="outline" label="Browse saved posts" onPress={leave} />
          <ActionButton kind="plain" label="Try again" onPress={() => engineSupervisor.restart(`Try again (${title})`)} />
        </View>
      </View>
    </Screen>
  );
}
