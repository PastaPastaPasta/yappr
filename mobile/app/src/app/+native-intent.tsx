import type { NativeIntent } from 'expo-router';

import { FALLBACK_ROUTE, toAppRoute } from '~/navigation/deep-links';

/** Every inbound link (scheme, universal link, App Link) is translated here first. */
export const redirectSystemPath: NativeIntent['redirectSystemPath'] = ({ path }) => {
  try {
    return toAppRoute(path);
  } catch {
    // Throwing here crashes the app; a bad link just goes home.
    return FALLBACK_ROUTE;
  }
};
