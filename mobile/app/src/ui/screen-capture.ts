import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useId } from 'react';
import { Platform } from 'react-native';

/**
 * Keeps what is on screen out of screenshots, screen recordings and, on
 * Android, the Recents thumbnail (PRD AUTH-12, QA_RELEASE "screenshot blocked
 * on key screens").
 *
 * - `secret`: a private key is shown or typed. Blocked on both platforms.
 * - `private`: content Android would otherwise leak into Recents: DMs, and
 *   every screen while the app lock is on. Android only (FLAG_SECURE). iOS
 *   covers the app-switcher snapshot with the lock screen instead
 *   (`AppLockOverlay`), and its screenshot block is only used for secrets.
 */
export type CaptureScope = 'secret' | 'private';

export function blocksCapture(scope: CaptureScope, os: string = Platform.OS): boolean {
  if (scope === 'secret') return os === 'ios' || os === 'android';
  return os === 'android';
}

/**
 * Blocks screen capture while `active` (pass `useIsFocused()` from a screen,
 * since tab and stack screens stay mounted underneath others). Each caller
 * holds its own key, so capture is allowed again only when none is active.
 */
export function useBlockScreenCapture(scope: CaptureScope, active = true): void {
  const key = useId();
  const on = active && blocksCapture(scope);
  useEffect(() => {
    if (!on) return;
    ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
    return () => {
      ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
    };
  }, [key, on]);
}
