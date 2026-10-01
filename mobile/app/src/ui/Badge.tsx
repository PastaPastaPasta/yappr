import { View } from 'react-native';

import { cn } from '~/lib-allowlist';

import { Text } from './Text';
import { tw } from './tokens';

/** "99+" past 99, as the web's notification badge. */
export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
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
      <Text variant="captionStrong" tone="inverse" tabular maxFontSizeMultiplier={1.5}>
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
