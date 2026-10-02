import { useNavigation } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { ArrowLeftIcon, ChevronLeftIcon } from 'react-native-heroicons/outline';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { colors, hitSlopFor, tw, useColors, type IconComponent } from '~/ui/tokens';

/** The bar's own height under the status bar. */
export const TOP_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;

/** The full height the bar covers: the status bar plus the bar. */
export function useTopBarHeight(): number {
  return useSafeAreaInsets().top + TOP_BAR_HEIGHT;
}

/**
 * A round icon button for the bar. Over the banner it is white on a 28 pt
 * `rgba(0,0,0,0.4)` circle (UX_SPEC §4.12); once the bar is solid it is a
 * plain icon in the text color.
 */
export function TopBarIcon({
  icon: Icon,
  overBanner,
  accessibilityLabel,
  onPress,
  testID,
}: {
  icon: IconComponent;
  overBanner: boolean;
  accessibilityLabel: string;
  onPress?: () => void;
  testID?: string;
}) {
  const c = useColors();
  // Inside a menu the menu view is the button (it takes the tap), so this view carries the label.
  const inMenu = !onPress;
  const content = (
    <View
      className="h-8 w-8 items-center justify-center rounded-full"
      style={overBanner ? { backgroundColor: 'rgba(0,0,0,0.4)' } : undefined}
      accessible={inMenu}
      accessibilityRole={inMenu ? 'button' : undefined}
      accessibilityLabel={inMenu ? accessibilityLabel : undefined}
      testID={inMenu ? testID : undefined}
    >
      <Icon size={20} color={overBanner ? colors.white : c.textPrimary} />
    </View>
  );
  if (inMenu) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlopFor(32)}
      onPress={onPress}
      testID={testID}
      className="active:opacity-70"
    >
      {content}
    </Pressable>
  );
}

export interface ProfileTopBarProps {
  /** Shown once the banner has scrolled away. */
  title?: string;
  /** The banner is under the bar: transparent, with round icon backdrops. */
  overBanner: boolean;
  /** Trailing buttons. */
  right?: ReactNode;
}

/**
 * The profile's navigation bar (UX_SPEC §3.4, §4.12): over the banner it is
 * transparent with white icons on dark circles; when the banner scrolls off
 * it turns into a solid bar with the name as an inline title.
 */
export function ProfileTopBar({ title, overBanner, right }: ProfileTopBarProps) {
  const insets = useSafeAreaInsets();
  // This stack's own history: a tab root has no Back, whatever other tabs hold.
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();
  return (
    <View
      className={cn('absolute left-0 right-0 top-0 z-10', !overBanner && cn(tw.bg, 'border-b', tw.border))}
      style={{ paddingTop: insets.top }}
      testID="profile-top-bar"
    >
      <View className="flex-row items-center gap-2 px-3" style={{ height: TOP_BAR_HEIGHT }}>
        {canGoBack ? (
          <TopBarIcon
            icon={Platform.OS === 'ios' ? ChevronLeftIcon : ArrowLeftIcon}
            overBanner={overBanner}
            accessibilityLabel="Back"
            onPress={() => navigation.goBack()}
            testID="profile-back"
          />
        ) : null}
        <View className="flex-1 px-1">
          {!overBanner && title ? (
            <Text variant="headline" tone="emphasis" numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-center gap-3">{right}</View>
      </View>
    </View>
  );
}
