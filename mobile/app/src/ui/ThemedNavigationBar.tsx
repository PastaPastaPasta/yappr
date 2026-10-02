import { NavigationBar } from 'expo-navigation-bar';

import { useIsDark } from './tokens';

/**
 * Android's system navigation bar (the gesture handle or the 3-button bar),
 * light buttons on the dark theme and dark ones on the light theme, from the
 * effective theme (the Settings > Appearance override included), as
 * `ThemedStatusBar` does for the status bar. React Native sets the bar's
 * appearance once, from the system theme, when the activity starts, so
 * without this an override (or a system change while the app runs) leaves
 * the handle unreadable. iOS has no such bar; the component renders nothing.
 *
 * Only the buttons are styled. The app is edge to edge (enforced from
 * Android 15), so the bar has no color of its own: the screen behind it, the
 * tab bar or a sheet in the theme's `bg`, shows through. In 3-button mode
 * the system keeps its contrast scrim (`enforceContrast`, on by default),
 * tinted to match the style.
 *
 * `style` names the buttons' color, like expo-status-bar's: 'light' is light
 * buttons for a dark background.
 */
export function ThemedNavigationBar() {
  return <NavigationBar style={useIsDark() ? 'light' : 'dark'} />;
}
