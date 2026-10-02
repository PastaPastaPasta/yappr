import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';

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
