import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

/**
 * Full-screen content above everything, native modals included. On iOS a
 * presented modal (sign-in, compose) is its own view controller, above the
 * root view, so the overlay lives in its own window; on Android modals are
 * views in the same hierarchy, and the last root child is on top.
 */
export function TopOverlay({ children }: { children: ReactNode }) {
  const content = (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {children}
    </View>
  );
  return Platform.OS === 'ios' ? <FullWindowOverlay>{content}</FullWindowOverlay> : content;
}
