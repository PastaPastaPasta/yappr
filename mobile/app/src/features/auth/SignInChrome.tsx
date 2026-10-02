import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { XMarkIcon } from 'react-native-heroicons/outline';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cn } from '~/lib-allowlist';
import { IconButton } from '~/ui/IconButton';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { Text } from '~/ui/Text';
import { hitSlopFor, tw } from '~/ui/tokens';

import { copy } from './copy';

/**
 * The leading header control of the sign-in modal (UX_SPEC §4.2): "Cancel"
 * on iOS (page sheet), a close × on Android (full-screen dialog).
 */
export function HeaderClose({ onPress, label = copy.signin.cancel }: { onPress: () => void; label?: string }) {
  if (Platform.OS === 'android') {
    return <IconButton icon={XMarkIcon} accessibilityLabel={label} onPress={onPress} testID="sign-in-close" />;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={hitSlopFor(24)}
      onPress={onPress}
      testID="sign-in-close"
      className="px-1 active:opacity-60"
    >
      <Text variant="body" tone="link">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A sign-in screen's scrolling body: page background, side margins, and the
 * actions pinned to the bottom above the home indicator.
 */
export function SignInBody({
  children,
  footer,
  center = false,
  testID,
}: {
  children: ReactNode;
  /** Buttons pinned at the bottom (they stay reachable at large text sizes). */
  footer?: ReactNode;
  /** Vertically center the content (status screens). */
  center?: boolean;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoider>
      <View className={cn('flex-1', tw.bg)} testID={testID}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerClassName={cn('grow gap-4 px-6 pb-6 pt-4', center && 'justify-center')}
        >
          {children}
        </ScrollView>
        {footer ? (
          <View className="gap-3 px-6 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            {footer}
          </View>
        ) : null}
      </View>
    </KeyboardAvoider>
  );
}
