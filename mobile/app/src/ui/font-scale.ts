import { useSyncExternalStore } from 'react';
import { Dimensions, Platform } from 'react-native';

/**
 * Android's system font scale, for remounting text when it changes while the
 * app is open (`Text`, D-rc5a-001). One Dimensions listener for the app, and
 * a re-render only when the scale itself changes, not on every window resize
 * (rotation, split screen). iOS re-lays out its text for Dynamic Type itself:
 * there this is always 1.
 */

const android = () => Platform.OS === 'android';
const listeners = new Set<() => void>();
let subscription: { remove: () => void } | null = null;

const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void): () => void {
  if (!android()) return () => undefined;
  listeners.add(listener);
  subscription ??= Dimensions.addEventListener('change', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

const getFontScale = () => (android() ? Dimensions.get('window').fontScale : 1);

/** The font scale on Android (re-rendering when it changes), 1 on iOS. */
export function useAndroidFontScale(): number {
  return useSyncExternalStore(subscribe, getFontScale);
}
