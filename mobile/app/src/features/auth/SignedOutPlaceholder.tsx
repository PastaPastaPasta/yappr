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
  WrenchScrewdriverIcon,
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
    description: 'Log in to view your personalized following feed and see updates from accounts you care about.',
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

/** The Settings sections that need no account (AUTH-02). */
const SETTINGS_LINKS: { label: string; href: Href; icon: IconComponent }[] = [
  { label: 'Appearance', href: '/settings/appearance', icon: PaintBrushIcon },
  { label: 'Privacy & Safety', href: '/settings/privacy', icon: ShieldCheckIcon },
  { label: 'About', href: '/settings/about', icon: InformationCircleIcon },
  { label: 'Engine diagnostics', href: '/settings/diagnostics', icon: WrenchScrewdriverIcon },
];

function SettingsLinks() {
  const c = useColors();
  return (
    <View className={cn('mx-4 overflow-hidden rounded-xl border', tw.border)}>
      {SETTINGS_LINKS.map(({ label, href, icon: Icon }, index) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => router.push(href)}
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
 * A signed-out tab: icon, title, description and "Sign in". The Profile tab
 * also links the Settings sections that need no account.
 */
export function SignedOutPlaceholder({ kind, screenTitle }: { kind: SignedOutKind; screenTitle?: string }) {
  const { icon, title, description } = PLACEHOLDERS[kind];
  return (
    <Screen scroll>
      {screenTitle ? <Stack.Screen options={{ title: screenTitle }} /> : null}
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        action={{ label: copy.signedOut.signIn, onPress: () => router.push('/sign-in') }}
        testID={`signed-out-${kind}`}
      />
      {kind === 'profile' ? <SettingsLinks /> : null}
    </Screen>
  );
}
