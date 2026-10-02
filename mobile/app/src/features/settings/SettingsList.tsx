import { Stack } from 'expo-router';
import { Children, isValidElement, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { ChevronRightIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { colors, tw, useColors, useIsDark, useLargeText, type IconComponent } from '~/ui/tokens';

/**
 * The settings list (UX_SPEC §2.9, §4.25): an inset grouped list on iOS
 * (rounded cards on the grouped background, chevrons), a flat Material list
 * on Android (accent section headers, leading icons, no chevrons).
 */

const ios = Platform.OS === 'ios';

/** The grouped page behind the cards on iOS; Android uses the page surface. */
const PAGE = ios ? 'bg-gray-100 dark:bg-black' : tw.bg;
const pageColor = (dark: boolean) => {
  if (!ios) return dark ? colors.neutral900 : colors.white;
  return dark ? colors.black : colors.gray100;
};

/**
 * The header for a settings screen: the title, large on iOS where the spec
 * asks for it (Settings root), on the grouped background so the header and
 * the page read as one surface.
 */
export function SettingsHeader({ title, large = false }: { title: string; large?: boolean }) {
  const dark = useIsDark();
  const background = pageColor(dark);
  return (
    <Stack.Screen
      options={{
        title,
        headerLargeTitle: ios && large,
        headerShadowVisible: !ios,
        headerLargeTitleStyle: ios && large ? { color: dark ? colors.white : colors.gray900 } : undefined,
        headerStyle: ios && !large ? { backgroundColor: background } : undefined,
      }}
    />
  );
}

/** A non-scrolling settings page (loading, empty and error states) on the same background. */
export function SettingsPage({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View className={cn('flex-1', PAGE)} testID={testID}>
      {children}
    </View>
  );
}

export function SettingsScroll({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <ScrollView
      className={cn('flex-1', PAGE)}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="pb-10"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

export interface SettingsGroupProps {
  /** Section header (UX_SPEC: 8 above the group, 24 between groups). */
  title?: string;
  /** A note under the group, `subhead` secondary. */
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}

/** One group of rows, with hairline separators between them. */
export function SettingsGroup({ title, footer, children, testID }: SettingsGroupProps) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View className={ios ? 'px-4 pt-6' : 'pt-4'} testID={testID}>
      {title ? (
        <Text
          variant={ios ? 'caption' : 'subheadStrong'}
          tone={ios ? 'secondary' : 'link'}
          accessibilityRole="header"
          className={ios ? 'px-4 pb-2 uppercase tracking-wide' : 'px-4 pb-1'}
        >
          {title}
        </Text>
      ) : null}
      <View className={ios ? 'overflow-hidden rounded-xl bg-white dark:bg-neutral-900' : undefined}>
        {rows.map((row, index) => (
          <View key={row.key ?? index}>
            {/* iOS separates rows with a hairline inset from the leading edge (the row's content
                stays put); Material lists separate groups, not rows. */}
            {ios && index > 0 ? <View className={cn('absolute left-4 right-0 top-0 z-10 border-t', tw.border)} /> : null}
            {row}
          </View>
        ))}
      </View>
      {footer ? (
        <View className="px-4 pt-2">
          {typeof footer === 'string' ? (
            <Text variant="subhead" tone="secondary">
              {footer}
            </Text>
          ) : (
            footer
          )}
        </View>
      ) : null}
      {ios ? null : <View className={cn('mt-4 border-b', tw.border)} />}
    </View>
  );
}

export interface SettingsRowProps {
  label: string;
  /** A second line under the label. */
  description?: string;
  /** Trailing value (iOS) or second line (Android), `text.secondary`. */
  value?: string;
  icon?: IconComponent;
  /** Tint for the leading icon's square on iOS. */
  iconTint?: string;
  onPress?: () => void;
  /** A navigation row: chevron on iOS. Off for actions and external links. */
  chevron?: boolean;
  /** Something trailing in place of the chevron (a check mark, a button). */
  trailing?: ReactNode;
  /** Red label; centered on iOS, leading on Android (UX_SPEC §2.9). */
  destructive?: boolean;
  /** A link-styled action row. */
  link?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'link';
  testID?: string;
}

/** A navigation, action or destructive row (UX_SPEC §2.9). Min height 52 on iOS, 56 on Android. */
export function SettingsRow({
  label,
  description,
  value,
  icon: Icon,
  iconTint,
  onPress,
  chevron = !!onPress,
  trailing,
  destructive = false,
  link = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  testID,
}: SettingsRowProps) {
  const c = useColors();
  const large = useLargeText();
  const centered = destructive && ios && !Icon;
  const tone = destructive ? 'destructive' : link ? 'link' : 'primary';
  // Android shows a value as the second line, as Material settings do; so do large text sizes (UX_SPEC §6.1).
  const valueBelow = !ios || large;

  const body = (
    <>
      {Icon ? (
        ios ? (
          <View
            className="h-8 w-8 items-center justify-center rounded-lg"
            style={{ backgroundColor: iconTint ?? colors.gray500 }}
          >
            <Icon size={20} color={colors.white} />
          </View>
        ) : (
          <View className="w-8 items-center">
            <Icon size={24} color={destructive ? c.destructive : c.textSecondary} />
          </View>
        )
      ) : null}
      <View className={cn('flex-1 gap-0.5', centered && 'items-center')}>
        <Text variant="body" tone={tone}>
          {label}
        </Text>
        {description ? (
          <Text variant="subhead" tone="secondary">
            {description}
          </Text>
        ) : null}
        {value && valueBelow ? (
          <Text variant="subhead" tone="secondary">
            {value}
          </Text>
        ) : null}
      </View>
      {value && !valueBelow ? (
        <Text variant="body" tone="secondary" numberOfLines={1} className="max-w-[55%]">
          {value}
        </Text>
      ) : null}
      {trailing}
      {chevron && ios && !trailing ? <ChevronRightIcon size={16} color={c.textDisabled} strokeWidth={2.5} /> : null}
    </>
  );

  const className = cn('flex-row items-center gap-3 px-4 py-3', ios ? 'min-h-[52px]' : 'min-h-14');
  if (!onPress) {
    return (
      <View className={className} testID={testID} accessible accessibilityLabel={accessibilityLabel ?? [label, value].filter(Boolean).join(', ')}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? [label, value].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint ?? description}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={cn(className, tw.pressed, disabled && 'opacity-50')}
    >
      {body}
    </Pressable>
  );
}
