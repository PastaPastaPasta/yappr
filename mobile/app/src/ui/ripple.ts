import { Platform, type PressableAndroidRippleConfig } from 'react-native';

import { useColors } from './tokens';

/**
 * - `surface`: rows, cards, segments and outline buttons.
 * - `fill`: on an accent or destructive fill (primary buttons, the FAB).
 * - `icon`: icon-only controls; an unbounded circle over the 48 dp target.
 */
export type RippleKind = 'surface' | 'fill' | 'icon';

/** White over a colored fill: the theme's 8 % ripple doesn't show on `accent`. */
const FILL_RIPPLE = 'rgba(255,255,255,0.24)';
/** Half the 48 dp minimum target (UX_SPEC §6.4). */
const ICON_RADIUS = 24;

/**
 * Android's touch feedback (UX_SPEC §2.10 "Pressed": rows and buttons keep
 * their pressed fill, and Android adds the ripple). Pass the result as a
 * Pressable's `android_ripple`; it is `undefined` on iOS.
 *
 * Bounded ripples draw in the foreground: React Native masks a background
 * ripple with a plain rectangle, so it would spill past rounded corners, while
 * the foreground follows the view's clip (`overflow: hidden` + border radius).
 */
export function useRipple(kind: RippleKind = 'surface'): PressableAndroidRippleConfig | undefined {
  const c = useColors();
  if (Platform.OS !== 'android') return undefined;
  if (kind === 'icon') return { color: c.ripple, borderless: true, radius: ICON_RADIUS };
  return { color: kind === 'fill' ? FILL_RIPPLE : c.ripple, foreground: true };
}
