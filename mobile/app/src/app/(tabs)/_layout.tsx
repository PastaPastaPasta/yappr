import { Tabs } from 'expo-router';
import { Label, useTheme } from 'expo-router/react-navigation';
import type { ComponentType } from 'react';
import { Platform, useWindowDimensions, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { badgeLabel } from '~/ui/Badge';
import { colors, useIsDark } from '~/ui/tokens';

type HeroIcon = ComponentType<{ size?: number; color?: ColorValue }>;

const ICON_SIZE = 26;
/** The navigator's tab bar height (UIKit's 49) before the bottom inset, and its label size. */
const TAB_BAR_HEIGHT = 49;
const LABEL_SIZE = 10;
/** Tab labels stop growing at 1.5× (UX_SPEC §6.1). */
const MAX_LABEL_SCALE = 1.5;

function tabIcon(Outline: HeroIcon, Solid: HeroIcon) {
  function TabIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
    const Icon = focused ? Solid : Outline;
    return <Icon size={ICON_SIZE} color={color} />;
  }
  return TabIcon;
}

/**
 * Android's tab label, capped at 1.5× font scale and shrunk to fit its tab,
 * so a large font scale doesn't clip it under the tab bar or cut
 * "Notifications" short. iOS keeps the navigator's label, which doesn't scale
 * (the Large Content Viewer shows it instead).
 */
function AndroidTabLabel({ color, beside, children }: { color: ColorValue; beside: boolean; children: string }) {
  const { fonts } = useTheme();
  return (
    <Label
      tintColor={color}
      // Beside the icon (tablets, landscape), the navigator's own label metrics.
      style={[beside ? { fontSize: 13, marginStart: 5 } : { fontSize: LABEL_SIZE }, fonts.medium]}
      maxFontSizeMultiplier={MAX_LABEL_SCALE}
      adjustsFontSizeToFit
    >
      {children}
    </Label>
  );
}

/**
 * On Android the bar grows with its label (a 1.4 line height per scaled
 * point), so a large font scale doesn't cut the descenders off.
 */
function useAndroidTabBarStyle() {
  const { fontScale } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  if (Platform.OS !== 'android' || fontScale <= 1) return undefined;
  const growth = Math.ceil(LABEL_SIZE * (Math.min(fontScale, MAX_LABEL_SCALE) - 1) * 1.4);
  return { height: TAB_BAR_HEIGHT + growth + bottom };
}

const tabBarLabel =
  Platform.OS === 'android'
    ? ({ color, position, children }: { color: ColorValue; position: 'beside-icon' | 'below-icon'; children: string }) => (
        <AndroidTabLabel color={color} beside={position === 'beside-icon'}>
          {children}
        </AndroidTabLabel>
      )
    : undefined;

/** A count of 0 shows no badge; past 99 it reads "99+" (NOTIF-03). */
const badge = (count: number | undefined) => (count ? badgeLabel(count) : undefined);

/**
 * ADR-001 E4 / UX_SPEC §3.1: five tabs with labels, Notifications promoted
 * from the web's Menu sheet. A JS tab bar with Heroicons and web-matching
 * styling (lead decision, overriding UX_SPEC §3.1's native tabs). Each tab is
 * its own stack (the shared group layout), so this navigator has no header.
 */
export default function TabLayout() {
  const dark = useIsDark();
  const badges = useTabBadges();
  const tabBarStyle = useAndroidTabBarStyle();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarLabel,
        tabBarStyle,
        tabBarActiveTintColor: dark ? colors.white : colors.black,
        tabBarInactiveTintColor: colors.gray500,
      }}
    >
      <Tabs.Screen
        name="(home)"
        options={{ title: 'Home', tabBarButtonTestID: 'tab-home', tabBarIcon: tabIcon(HomeOutline, HomeSolid) }}
      />
      <Tabs.Screen
        name="(explore)"
        options={{ title: 'Explore', tabBarButtonTestID: 'tab-explore', tabBarIcon: tabIcon(SearchOutline, SearchSolid) }}
      />
      <Tabs.Screen
        name="(notifications)"
        options={{
          title: 'Notifications',
          tabBarButtonTestID: 'tab-notifications',
          tabBarIcon: tabIcon(BellOutline, BellSolid),
          tabBarBadge: badge(badges.notifications),
        }}
      />
      <Tabs.Screen
        name="(messages)"
        options={{
          title: 'Messages',
          tabBarButtonTestID: 'tab-messages',
          tabBarIcon: tabIcon(EnvelopeOutline, EnvelopeSolid),
          tabBarBadge: badge(badges.messages),
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{ title: 'Profile', tabBarButtonTestID: 'tab-profile', tabBarIcon: tabIcon(UserOutline, UserSolid) }}
        // Long-press opens the account switcher (PRD AUTH-10).
        listeners={{ tabLongPress: openAccountSwitcher }}
      />
    </Tabs>
  );
}
