import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';

/**
 * The app-wide status bar, light text on the dark theme and dark text on the
 * light one. It follows the effective theme (NativeWind's color scheme, which
 * carries the Settings > Appearance override), not the system's: expo-status-bar's
 * `style="auto"` reads React Native's `useColorScheme`, which left the clock
 * dark on a dark iOS screen.
 */
export function ThemedStatusBar() {
  const dark = useColorScheme().colorScheme === 'dark';
  return <StatusBar style={dark ? 'light' : 'dark'} />;
}
