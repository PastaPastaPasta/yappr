import { router, Stack, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';
import {
  BellIcon,
  ChevronRightIcon,
  EnvelopeIcon,
  InformationCircleIcon,
  PaintBrushIcon,
  ShieldCheckIcon,
  UserIcon,
  UsersIcon,
} from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { EmptyState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Text } from '~/ui/Text';
import { tw, useColors, type IconComponent } from '~/ui/tokens';

import { copy } from './copy';

/** UX_SPEC §4.37: what a tab or screen shows signed out (AUTH-02). */
const PLACEHOLDERS = {
  following: {
    icon: UsersIcon,
    title: 'See posts from people you follow',
    description: 'Sign in to see posts from people you follow.',
  },
  notifications: {
    icon: BellIcon,
    title: 'Sign in to see your notifications',
    description: 'Likes, replies, follows and mentions show up here.',
  },
  messages: {
    icon: EnvelopeIcon,
    title: 'Sign in to read your messages',
    description: 'Private 1-on-1 and group conversations.',
  },
  profile: {
    icon: UserIcon,
    title: 'Sign in to post, follow and message',
    description: 'You can keep browsing without an account.',
  },
} as const;

export type SignedOutKind = keyof typeof PLACEHOLDERS;

/** The Settings sections that need no account (AUTH-02). Troubleshooting is at the bottom of About. */
const SETTINGS_LINKS: { label: string; href: Href; icon: IconComponent; testID: string }[] = [
  { label: 'Appearance', href: '/settings/appearance', icon: PaintBrushIcon, testID: 'signed-out-settings-appearance' },
  { label: 'Privacy & Safety', href: '/settings/privacy', icon: ShieldCheckIcon, testID: 'signed-out-settings-privacy' },
  { label: 'About', href: '/settings/about', icon: InformationCircleIcon, testID: 'signed-out-settings-about' },
];

function SettingsLinks() {
  const c = useColors();
  return (
    <View className={cn('mx-4 overflow-hidden rounded-xl border', tw.border)}>
      {SETTINGS_LINKS.map(({ label, href, icon: Icon, testID }, index) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => router.push(href)}
          testID={testID}
          className={cn('min-h-12 flex-row items-center gap-3 px-4 py-3', tw.pressed, index > 0 && cn('border-t', tw.border))}
        >
          <Icon size={20} color={c.textSecondary} />
          <Text variant="body" className="flex-1">
            {label}
          </Text>
          <ChevronRightIcon size={16} color={c.textSecondary} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The signed-out empty state alone (icon, title, description and "Sign in",
 * whose test ID is `signed-out-<kind>-action`), for a screen that keeps its
 * own list mounted while signed out, as an iOS large-title screen must.
 */
export function SignedOutEmptyState({ kind }: { kind: SignedOutKind }) {
  const { icon, title, description } = PLACEHOLDERS[kind];
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={{ label: copy.signedOut.signIn, onPress: () => router.push('/sign-in') }}
      testID={`signed-out-${kind}`}
    />
  );
}

/**
 * A signed-out tab: icon, title, description and "Sign in". The Profile tab
 * also links the Settings sections that need no account.
 */
export function SignedOutPlaceholder({ kind, screenTitle }: { kind: SignedOutKind; screenTitle?: string }) {
  return (
    <Screen scroll>
      {screenTitle ? <Stack.Screen options={{ title: screenTitle }} /> : null}
      <SignedOutEmptyState kind={kind} />
      {kind === 'profile' ? <SettingsLinks /> : null}
    </Screen>
  );
}
