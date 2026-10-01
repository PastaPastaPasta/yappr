import { Redirect, Stack } from 'expo-router';

import { FALLBACK_ROUTE } from '~/navigation/deep-links';
import { Screen } from '~/ui/Screen';

/**
 * Unknown routes (stale or unsupported links) go home. It paints the themed
 * surface for the frame before the redirect lands.
 * TODO(shell PR): the "This link isn't supported in the app" toast.
 */
export default function NotFound() {
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <Redirect href={FALLBACK_ROUTE} />
    </Screen>
  );
}
