import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { useRef, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useAppearance, type ThemePreference } from '~/state/appearance';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { colors, useIsDark } from '~/ui/tokens';

/**
 * Dev-only (guarded in the root layout): renders the shared tokens so each UI
 * PR can screenshot them in light and dark. The design-system PR adds every
 * primitive here.
 */

// Literal class names: Tailwind only generates classes it can find in source.
const YAPPR_RAMP = [
  'bg-yappr-50',
  'bg-yappr-100',
  'bg-yappr-200',
  'bg-yappr-300',
  'bg-yappr-400',
  'bg-yappr-500',
  'bg-yappr-600',
  'bg-yappr-700',
  'bg-yappr-800',
  'bg-yappr-900',
  'bg-yappr-950',
];
const NEUTRALS = ['bg-neutral-750', 'bg-neutral-850', 'bg-neutral-900'];
const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2 border-b border-gray-200 px-4 py-4 dark:border-gray-800">
      <Text variant="muted">{title}</Text>
      {children}
    </View>
  );
}

export default function GalleryScreen() {
  const { theme, setTheme } = useAppearance();
  const sheet = useRef<BottomSheetModal>(null);
  const dark = useIsDark();

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Gallery' }} />
      <Section title="Theme (Settings > Appearance plumbing)">
        <View className="flex-row gap-2">
          {THEMES.map((t) => (
            <Pressable
              key={t}
              onPress={() => setTheme(t)}
              className={`rounded-full px-4 py-2 ${t === theme ? 'bg-yappr-500' : 'bg-gray-100 dark:bg-gray-800'}`}
            >
              <Text variant={t === theme ? 'onBrand' : 'body'}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      <Section title="yappr-50 … yappr-950">
        <View className="flex-row">
          {YAPPR_RAMP.map((c) => (
            <View key={c} className={`h-8 flex-1 ${c}`} />
          ))}
        </View>
      </Section>

      <Section title="neutral-750 / neutral-850 / neutral-900">
        <View className="flex-row gap-2">
          {NEUTRALS.map((c) => (
            <View key={c} className={`h-8 flex-1 rounded-lg ${c}`} />
          ))}
        </View>
      </Section>

      <Section title="shadow-yappr / shadow-yappr-lg">
        <View className="flex-row gap-6 py-4">
          <View className="h-12 flex-1 rounded-full bg-yappr-500 shadow-yappr" />
          <View className="h-12 flex-1 rounded-full bg-yappr-500 shadow-yappr-lg" />
        </View>
      </Section>

      <Section title="Bottom sheet (@gorhom/bottom-sheet)">
        <Pressable
          onPress={() => sheet.current?.present()}
          className="self-start rounded-full bg-yappr-500 px-4 py-2 active:bg-yappr-600"
        >
          <Text variant="onBrand">Open sheet</Text>
        </Pressable>
      </Section>

      <BottomSheetModal
        ref={sheet}
        backgroundStyle={{ backgroundColor: dark ? colors.neutral900 : colors.white }}
        handleIndicatorStyle={{ backgroundColor: colors.gray500 }}
      >
        <BottomSheetView style={{ alignItems: 'center', padding: 32 }}>
          <Text>Hello from a bottom sheet</Text>
        </BottomSheetView>
      </BottomSheetModal>
    </Screen>
  );
}
