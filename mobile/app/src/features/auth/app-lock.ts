import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { appendLog, errorMessage } from '~/engine/logs';
import { syncStorage } from '~/state/storage';

import { copy } from './copy';

/**
 * Optional biometric app lock (PRD AUTH-12, UX_SPEC §4.36). Device-wide.
 * The OS prompt allows the device passcode as a fallback.
 */

export const LOCK_TIMEOUTS = [0, 60_000, 300_000, 900_000] as const;
export type LockTimeout = (typeof LOCK_TIMEOUTS)[number];

const isLockTimeout = (value: unknown): value is LockTimeout =>
  LOCK_TIMEOUTS.includes(value as LockTimeout);

interface AppLockSettings {
  enabled: boolean;
  timeoutMs: LockTimeout;
}

export const useAppLockSettings = create<AppLockSettings>()(
  persist((): AppLockSettings => ({ enabled: false, timeoutMs: 0 }), {
    name: 'app-lock',
    version: 1,
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => {
      const p = persisted as Partial<AppLockSettings> | undefined;
      return {
        ...current,
        enabled: p?.enabled === true,
        timeoutMs: isLockTimeout(p?.timeoutMs) ? p.timeoutMs : 0,
      };
    },
  }),
);

interface LockState {
  /** Content is hidden until the user authenticates. */
  locked: boolean;
  /** The app is inactive or in the background: the app-switcher snapshot shows the lock screen. */
  covered: boolean;
  /** The OS prompt is up (it makes the app inactive on iOS; that must not re-lock). */
  authenticating: boolean;
  /** When the app last went to the background, for the timeout. */
  backgroundAt: number | null;
}

/** A cold launch with the lock on starts locked. */
export const useLockState = create<LockState>()(() => ({
  locked: useAppLockSettings.getState().enabled,
  covered: false,
  authenticating: false,
  backgroundAt: null,
}));

/**
 * The app moved between foreground states (`AppState`). Pure state logic, so
 * it is unit-tested: the lock engages on return when the app was in the
 * background for at least the timeout.
 */
export function appStateChanged(next: string, now = Date.now()): void {
  const { enabled, timeoutMs } = useAppLockSettings.getState();
  const state = useLockState.getState();
  if (!enabled) {
    if (state.locked || state.covered) useLockState.setState({ locked: false, covered: false });
    return;
  }
  if (next === 'active') {
    const away = state.backgroundAt === null ? null : now - state.backgroundAt;
    useLockState.setState({
      covered: false,
      backgroundAt: null,
      locked: state.locked || (away !== null && away >= timeoutMs),
    });
    return;
  }
  if (state.authenticating) return;
  useLockState.setState({
    covered: true,
    backgroundAt: next === 'background' ? (state.backgroundAt ?? now) : state.backgroundAt,
  });
}

/** One OS authentication prompt; true when it passed. */
export async function authenticate(): Promise<boolean> {
  useLockState.setState({ authenticating: true });
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: copy.lock.prompt,
      disableDeviceFallback: false,
    });
    return result.success;
  } catch (error) {
    appendLog('warn', 'host', `App lock prompt failed: ${errorMessage(error)}`);
    return false;
  } finally {
    useLockState.setState({ authenticating: false });
  }
}

/** Ask for authentication and unlock on success. */
export async function unlock(): Promise<boolean> {
  const passed = await authenticate();
  if (passed) useLockState.setState({ locked: false, covered: false });
  return passed;
}

/** Turning the lock on needs one successful check (AUTH-12); turning it off does not. */
export async function setAppLockEnabled(enabled: boolean): Promise<boolean> {
  if (enabled && !(await authenticate())) return false;
  useAppLockSettings.setState({ enabled });
  return true;
}

export interface LockCapability {
  /** A biometric or a device passcode is set up, so the lock can work. */
  available: boolean;
  /** "Require Face ID" / "Require Touch ID" / "Require fingerprint or device PIN". */
  label: string;
}

/** What this device can lock with, read once per mount. null while reading. */
export function useLockCapability(): LockCapability | null {
  const [capability, setCapability] = useState<LockCapability | null>(null);
  useEffect(() => {
    let live = true;
    readLockCapability()
      .then((value) => {
        if (live) setCapability(value);
      })
      .catch(() => {
        if (live) setCapability({ available: false, label: lockLabel([]) });
      });
    return () => {
      live = false;
    };
  }, []);
  return capability;
}

export function lockLabel(types: readonly LocalAuthentication.AuthenticationType[]): string {
  if (Platform.OS === 'android') return 'Require fingerprint or device PIN';
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Require Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Require Touch ID';
  return 'Require device passcode';
}

async function readLockCapability(): Promise<LockCapability> {
  const [level, types] = await Promise.all([
    LocalAuthentication.getEnrolledLevelAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);
  return { available: level !== LocalAuthentication.SecurityLevel.NONE, label: lockLabel(types) };
}
