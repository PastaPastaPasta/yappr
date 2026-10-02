import { requireOptionalNativeModule } from 'expo';

/** This module's Android side (`android/`). There is no iOS side; see index.ios.ts. */
const native = requireOptionalNativeModule<{ setSecure(on: boolean): void }>('SecureWindow');

/**
 * Android: FLAG_SECURE on the app window (no screenshots, a blank Recents
 * thumbnail), re-applied whenever the Activity returns to the foreground.
 * Returns false when the native module is missing (an older dev client).
 */
export function setCaptureBlocked(on: boolean): Promise<boolean> {
  if (!native) return Promise.resolve(false);
  native.setSecure(on);
  return Promise.resolve(true);
}
