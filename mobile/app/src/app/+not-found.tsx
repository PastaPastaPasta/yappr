import { Redirect, Stack } from 'expo-router';

import { FALLBACK_ROUTE } from '~/navigation/deep-links';
import { Screen } from '~/ui/Screen';

/**
 * Unknown routes go home. Inbound links never land here (`+native-intent`
 * routes unknown ones home with the unsupported-link toast); this catches a
 * stale in-app route. It paints the themed surface for the frame before the
 * redirect lands.
 */
export default function NotFound() {
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <Redirect href={FALLBACK_ROUTE} />
    </Screen>
  );
}
