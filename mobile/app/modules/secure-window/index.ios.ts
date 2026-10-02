import {
  allowScreenCaptureAsync,
  disableAppSwitcherProtectionAsync,
  enableAppSwitcherProtectionAsync,
  preventScreenCaptureAsync,
} from 'expo-screen-capture';

/**
 * iOS: expo-screen-capture's screenshot and recording block. It is linked on
 * iOS only (package.json `expo.autolinking.android.exclude`), so only this file
 * imports it. Call it only on a change: each native prevent wraps the window
 * once more, and one allow unwraps only one level.
 */
export async function setCaptureBlocked(on: boolean): Promise<boolean> {
  await (on ? preventScreenCaptureAsync() : allowScreenCaptureAsync());
  return true;
}

/**
 * iOS: a native blur over the app's root view from `willResignActive` until it
 * is active again, so the app-switcher snapshot never waits on a JS render.
 * It covers the root view only: presented modals sit above it.
 */
export async function setSwitcherProtected(on: boolean): Promise<boolean> {
  await (on ? enableAppSwitcherProtectionAsync(1) : disableAppSwitcherProtectionAsync());
  return true;
}
