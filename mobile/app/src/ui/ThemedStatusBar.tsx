import { StatusBar, setStatusBarStyle } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';

/** When to set the style again after a theme change: UIKit redraws the bar for the new appearance after React's update. */
const REAPPLY_AFTER_MS = [300, 1500] as const;

/**
 * The app-wide status bar, light text on the dark theme and dark text on the
 * light one, from the effective theme (NativeWind's color scheme, which
 * carries the Settings > Appearance override), not the system's.
 *
 * On iOS 26 the style React sets when the theme changes doesn't stick: UIKit
 * redraws the status bar for the new appearance afterwards and keeps the old
 * text color (expo-status-bar's `style="auto"` left the clock dark on the dark
 * theme), so it is set once more after the change settles.
 */
export function ThemedStatusBar() {
  const style = useColorScheme().colorScheme === 'dark' ? 'light' : 'dark';
  useEffect(() => {
    const timers = REAPPLY_AFTER_MS.map((ms) => setTimeout(() => setStatusBarStyle(style, false), ms));
    return () => timers.forEach(clearTimeout);
  }, [style]);
  return <StatusBar style={style} />;
}
