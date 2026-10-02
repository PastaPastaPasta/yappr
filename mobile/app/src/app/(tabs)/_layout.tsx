import { Tabs } from 'expo-router';
import type { ComponentType } from 'react';
import type { ColorValue } from 'react-native';
import {
  BellIcon as BellOutline,
  EnvelopeIcon as EnvelopeOutline,
  HomeIcon as HomeOutline,
  MagnifyingGlassIcon as SearchOutline,
  UserIcon as UserOutline,
} from 'react-native-heroicons/outline';
import {
  BellIcon as BellSolid,
  EnvelopeIcon as EnvelopeSolid,
  HomeIcon as HomeSolid,
  MagnifyingGlassIcon as SearchSolid,
  UserIcon as UserSolid,
} from 'react-native-heroicons/solid';

import { openAccountSwitcher } from '~/features/auth/AccountSwitcher';
import { useTabBadges } from '~/state/tab-badges';
import { colors, useIsDark } from '~/ui/tokens';

type HeroIcon = ComponentType<{ size?: number; color?: ColorValue }>;

const ICON_SIZE = 26;

function tabIcon(Outline: HeroIcon, Solid: HeroIcon) {
  function TabIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
    const Icon = focused ? Solid : Outline;
    return <Icon size={ICON_SIZE} color={color} />;
  }
  return TabIcon;
}

/** A count of 0 shows no badge. */
const badge = (count: number | undefined) => (count ? count : undefined);

/**
 * ADR-001 E4 / UX_SPEC §3.1: five tabs with labels, Notifications promoted
 * from the web's Menu sheet. A JS tab bar with Heroicons and web-matching
 * styling (lead decision, overriding UX_SPEC §3.1's native tabs). Each tab is
 * its own stack (the shared group layout), so this navigator has no header.
 */
export default function TabLayout() {
  const dark = useIsDark();
  const badges = useTabBadges();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: dark ? colors.white : colors.black,
        tabBarInactiveTintColor: colors.gray500,
      }}
    >
      <Tabs.Screen
        name="(home)"
        options={{ title: 'Home', tabBarIcon: tabIcon(HomeOutline, HomeSolid) }}
      />
      <Tabs.Screen
        name="(explore)"
        options={{ title: 'Explore', tabBarIcon: tabIcon(SearchOutline, SearchSolid) }}
      />
      <Tabs.Screen
        name="(notifications)"
        options={{
          title: 'Notifications',
          tabBarIcon: tabIcon(BellOutline, BellSolid),
          tabBarBadge: badge(badges.notifications),
        }}
      />
      <Tabs.Screen
        name="(messages)"
        options={{
          title: 'Messages',
          tabBarIcon: tabIcon(EnvelopeOutline, EnvelopeSolid),
          tabBarBadge: badge(badges.messages),
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{ title: 'Profile', tabBarIcon: tabIcon(UserOutline, UserSolid) }}
        // Long-press opens the account switcher (PRD AUTH-10).
        listeners={{ tabLongPress: openAccountSwitcher }}
      />
    </Tabs>
  );
}
