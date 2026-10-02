import { useEffect, useId } from 'react';
import { Platform } from 'react-native';

import { appendLog, errorMessage } from '~/engine/logs';

import { setCaptureBlocked, setSwitcherProtected } from '../../modules/secure-window';

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
 *
 * Android RN `Modal` windows (`Dialog`, sheets in a Modal) don't inherit
 * FLAG_SECURE, so never show a secret in one.
 */
export type CaptureScope = 'secret' | 'private';

export function blocksCapture(scope: CaptureScope, os: string = Platform.OS): boolean {
  if (scope === 'secret') return os === 'ios' || os === 'android';
  return os === 'android';
}

/** Everyone currently asking for the block. Native is told only on 0 → 1 and 1 → 0. */
const holders = new Set<string>();

function apply(on: boolean): void {
  setCaptureBlocked(on)
    .then((applied) => {
      if (!applied) appendLog('warn', 'host', 'Screen capture blocking is unavailable in this build');
    })
    .catch((error: unknown) => {
      appendLog('warn', 'host', `${on ? 'Blocking' : 'Allowing'} screen capture failed: ${errorMessage(error)}`);
    });
}

function hold(id: string): void {
  holders.add(id);
  if (holders.size === 1) apply(true);
}

function release(id: string): void {
  if (holders.delete(id) && holders.size === 0) apply(false);
}

/**
 * Blocks screen capture while `active` (pass `useIsFocused()` from a screen,
 * since tab and stack screens stay mounted underneath others). Capture comes
 * back only when no holder is left.
 */
export function useBlockScreenCapture(scope: CaptureScope, active = true): void {
  const id = useId();
  const on = active && blocksCapture(scope);
  useEffect(() => {
    if (!on) return;
    hold(id);
    return () => release(id);
  }, [id, on]);
}

/**
 * iOS: blur the app natively as it leaves the foreground, while `active`
 * (the app lock is on). The lock screen's own cover is a JS render, which a
 * busy JS thread can deliver after iOS has taken the app-switcher snapshot
 * (AUTH-12). Android needs nothing: FLAG_SECURE already blanks Recents.
 */
export function useAppSwitcherProtection(active: boolean): void {
  const on = active && Platform.OS === 'ios';
  useEffect(() => {
    if (!on) return;
    const set = (value: boolean) =>
      setSwitcherProtected(value).catch((error: unknown) => {
        appendLog('warn', 'host', `${value ? 'Enabling' : 'Disabling'} app-switcher protection failed: ${errorMessage(error)}`);
      });
    set(true);
    return () => {
      set(false);
    };
  }, [on]);
}
