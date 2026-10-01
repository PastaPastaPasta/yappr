import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { PlusIcon } from 'react-native-heroicons/outline';

import { lightImpact } from './haptics';
import { colors } from './tokens';

/**
 * The floating compose button (ADR-001 E4) on Home, Explore and Profile: the
 * web's 56px accent circle (yappr-600 in light mode, OQ-2) with `shadow-yappr-lg`. Render it as the
 * last child of the screen so it floats over the content.
 */
export function ComposeFab() {
  const onPress = () => {
    lightImpact();
    router.push('/compose');
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New post"
      testID="compose-fab"
      onPress={onPress}
      className="absolute bottom-4 right-4 h-14 w-14 items-center justify-center rounded-full bg-yappr-600 shadow-yappr-lg active:bg-yappr-700 dark:bg-yappr-500 dark:active:bg-yappr-600"
    >
      <PlusIcon size={28} color={colors.white} strokeWidth={2} />
    </Pressable>
  );
}
