import type { NativeIntent } from 'expo-router';

import { config } from '~/config';
import { takeWalletReturnLink } from '~/features/auth/key-exchange';
import { FALLBACK_ROUTE, toAppRoute } from '~/navigation/deep-links';

/** Every inbound link (scheme, universal link, App Link) is translated here first. */
export const redirectSystemPath: NativeIntent['redirectSystemPath'] = ({ path, initial }) => {
  try {
    // A wallet handing the user back mid sign-in: stay on the waiting screen (S1).
    if (takeWalletReturnLink(path, initial)) return null;
    return toAppRoute(path, {
      initial,
      webBasePath: config.webBasePath,
      allowAppRoutes: __DEV__,
    });
  } catch {
    // Throwing here crashes the app; a bad link just goes home.
    return FALLBACK_ROUTE;
  }
};
