import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

export interface KeyboardAvoiderProps {
  children: ReactNode;
  /**
   * Pad on iOS too. Off by default: iOS scroll views keep their fields
   * visible with `automaticallyAdjustKeyboardInsets`, which Android ignores.
   */
  avoidOnIOS?: boolean;
}

/**
 * Keeps a screen's fields and bottom buttons above the keyboard. Edge to edge,
 * Android no longer resizes the window for the keyboard (`adjustResize`), so
 * without this a focused field low on the screen sits under it.
 *
 * The offset is the navigation header above the screen: the keyboard's frame
 * is in window coordinates, the view's own layout is not. The context rather
 * than `useHeaderHeight()`, which throws outside a navigator. It is the
 * innermost stack's header only: right for full-screen screens and modals,
 * not under a transparent header, a form sheet or two stacked headers.
 */
export function KeyboardAvoider({ children, avoidOnIOS = false }: KeyboardAvoiderProps) {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  if (Platform.OS !== 'android' && !avoidOnIOS) return children;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'android' ? headerHeight : 0}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
