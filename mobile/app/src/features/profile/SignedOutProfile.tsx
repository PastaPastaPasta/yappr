import { router, Stack, type Href } from 'expo-router';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import {
  ChevronRightIcon,
  CpuChipIcon,
  InformationCircleIcon,
  PaintBrushIcon,
  ShieldCheckIcon,
  UserIcon,
} from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { EmptyState } from '~/ui/EmptyState';
import { Text } from '~/ui/Text';
import { tw, useColors, type IconComponent } from '~/ui/tokens';

const ROWS: { label: string; href: Href; icon: IconComponent; testID: string }[] = [
  { label: 'Appearance', href: '/settings/appearance', icon: PaintBrushIcon, testID: 'signed-out-appearance' },
  { label: 'Privacy & Safety', href: '/settings/privacy', icon: ShieldCheckIcon, testID: 'signed-out-privacy' },
  { label: 'About', href: '/settings/about', icon: InformationCircleIcon, testID: 'signed-out-about' },
  { label: 'Engine diagnostics', href: '/settings/diagnostics', icon: CpuChipIcon, testID: 'signed-out-diagnostics' },
];

/**
 * The Profile tab signed out (UX_SPEC §4.12, §4.37): the sign-in prompt,
 * then the settings that work without an account.
 */
export function SignedOutProfile() {
  const c = useColors();
  return (
    <ScrollView className={cn('flex-1', tw.bg)} contentInsetAdjustmentBehavior="automatic" testID="profile-signed-out">
      <Stack.Screen options={{ title: 'Profile', headerShown: true }} />
      <EmptyState
        title="Sign in to post, follow and message"
        description="You can keep browsing without an account."
        icon={UserIcon}
        action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        testID="profile-sign-in"
      />
      <View className={cn('mx-4 overflow-hidden rounded-xl border', tw.border)}>
        {ROWS.map((row, index) => (
          <Pressable
            key={row.label}
            accessibilityRole="button"
            onPress={() => router.push(row.href)}
            testID={row.testID}
            className={cn('min-h-12 flex-row items-center gap-3 px-4 py-3', tw.pressed, index > 0 && cn('border-t', tw.border))}
          >
            <row.icon size={22} color={c.textSecondary} />
            <Text className="flex-1">{row.label}</Text>
            {Platform.OS === 'ios' ? <ChevronRightIcon size={16} color={c.textDecorative} /> : null}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
