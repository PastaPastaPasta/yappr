import type { ReactNode } from 'react';
import { Modal, Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

const ignoreBack = () => undefined;

/**
 * Full-screen content above everything, native modals and bottom sheets
 * included. On iOS a presented modal (sign-in, compose) is its own view
 * controller, above the root view, so the overlay is a FullWindowOverlay: a
 * view react-native-screens adds to the app's window when it mounts. It is
 * above every modal presented before that, but not one presented after, so
 * nothing may open while the app lock shows (AuthGates, inbound-links), and
 * the lock mounts again when a root modal opens anyway (AppLockOverlay).
 * On Android the sheets' portal host renders after the root layout's
 * children, so a plain view would sit under an open sheet: the overlay is a
 * dialog window instead, which also takes the back button (ignored, so
 * nothing behind it can be popped while it shows).
 */
export function TopOverlay({ children }: { children: ReactNode }) {
  const content = (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {children}
    </View>
  );
  if (Platform.OS === 'ios') return <FullWindowOverlay>{content}</FullWindowOverlay>;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      hardwareAccelerated
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={ignoreBack}
    >
      {content}
    </Modal>
  );
}
