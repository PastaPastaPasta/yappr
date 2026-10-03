import { View } from 'react-native';

import { cn } from '~/lib-allowlist';

import { Text } from './Text';
import { tw } from './tokens';

/** "99+" past 99, as the web's notification badge. */
export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Badges stop growing at 1.5× the text size (UX_SPEC §6.1). */
export const BADGE_MAX_SCALE = 1.5;

/**
 * The tab bar's count badge (the navigator's `tabBarBadgeStyle`), with its
 * text not scaled by the system: UX_SPEC §2.19's 20 pt pill and
 * `caption.strong` number, box and text grown together with the font scale
 * up to `BADGE_MAX_SCALE`, so the number always fits its circle.
 */
export function tabBadgeStyle(fontScale: number) {
  const scale = Math.min(Math.max(fontScale, 1), BADGE_MAX_SCALE);
  const size = Math.round(20 * scale);
  return {
    height: size,
    minWidth: size,
    borderRadius: size / 2,
    // The navigator centres the number on its line box, a point under the badge height.
    lineHeight: size - 1,
    paddingHorizontal: Math.round(6 * scale),
    fontSize: Math.round(12 * scale),
    fontWeight: '600' as const,
  };
}

/** A 20 pt pill with a count on an accent fill (UX_SPEC §2.19). */
export function CountBadge({ count, accessibilityLabel }: { count: number; accessibilityLabel?: string }) {
  if (count <= 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? `${count} unread`}
      className={cn('h-5 min-w-5 items-center justify-center rounded-full px-1.5', tw.accentFill)}
    >
      <Text variant="captionStrong" tone="inverse" tabular maxFontSizeMultiplier={BADGE_MAX_SCALE}>
        {badgeLabel(count)}
      </Text>
    </View>
  );
}

/** The 8 pt unread dot. */
export function UnreadDot({ className }: { className?: string }) {
  return <View accessibilityLabel="Unread" className={cn('h-2 w-2 rounded-full bg-yappr-500', className)} />;
}

/** "Owner", "Follows you": small muted tags. */
export function Tag({ label }: { label: string }) {
  return (
    <View className={cn('self-start rounded px-1.5 py-0.5', tw.bgMuted)}>
      <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.5}>
        {label}
      </Text>
    </View>
  );
}
