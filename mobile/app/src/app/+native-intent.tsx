import type { NativeIntent } from 'expo-router';

import { config } from '~/config';
import { FALLBACK_ROUTE, toAppRoute } from '~/navigation/deep-links';

/** Every inbound link (scheme, universal link, App Link) is translated here first. */
export const redirectSystemPath: NativeIntent['redirectSystemPath'] = ({ path, initial }) => {
  try {
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
