import type { NativeStackNavigationOptions } from 'expo-router/native-stack';
import { Platform } from 'react-native';

/**
 * The Android top app bar title: the `title` token's 20 (UX_SPEC §1.6, §3.4).
 * Set explicitly because the toolbar's default title size is 20 dp, which
 * ignores the font scale; react-native-screens applies this one in sp, so the
 * title grows with the system font size (PRD A11Y-01, UX_SPEC §6.1). iOS keeps
 * UIKit's navigation bar fonts.
 */
export const ANDROID_HEADER_TITLE_SIZE = 20;

/** Screen options every stack in the app shares. Screens set their own `title`. */
export const stackScreenOptions: NativeStackNavigationOptions = {
  headerBackButtonDisplayMode: 'minimal',
  ...(Platform.OS === 'android' ? { headerTitleStyle: { fontSize: ANDROID_HEADER_TITLE_SIZE } } : {}),
};
