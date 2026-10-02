import { useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { useRootNavigationState } from 'expo-router';
import { AppState, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cn } from '~/lib-allowlist';
import { errorFeedback } from '~/ui/haptics';
import { Button } from '~/ui/Button';
import { useAppSwitcherProtection, useBlockScreenCapture } from '~/ui/screen-capture';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import icon from '@assets/images/icon.png';

import { appStateChanged, unlock, useAppLockSettings, useLockState } from './app-lock';
import { copy } from './copy';
import { TopOverlay } from './TopOverlay';

/** Prompt, and buzz when the OS prompt fails or is cancelled (UX_SPEC §1.9). */
function promptUnlock(): void {
  unlock()
    .then((passed) => {
      if (!passed) errorFeedback();
    })
    .catch(() => undefined);
}

/**
 * On iOS the lock is a FullWindowOverlay: above the modals presented before
 * it showed, not one presented after. A new root route (a modal) remounts
 * it, which adds it to the window again, on top. A frame late, so the
 * modal has been presented by then.
 */
function useRootLayer(): string {
  const signature = useRootNavigationState()?.routes?.map((route) => route.key).join('|') ?? '';
  const [layer, setLayer] = useState(signature);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setLayer(signature));
    return () => cancelAnimationFrame(frame);
  }, [signature]);
  return layer;
}

/**
 * The app lock screen (UX_SPEC §4.36): the app icon, "Yappr is locked" and
 * "Unlock". It also covers the app while inactive, so the app-switcher
 * snapshot shows it rather than content (AUTH-12).
 */
export function AppLockOverlay() {
  const enabled = useAppLockSettings((s) => s.enabled);
  const locked = useLockState((s) => s.locked);
  const covered = useLockState((s) => s.covered);
  const insets = useSafeAreaInsets();
  const prompted = useRef(false);
  const layer = useRootLayer();
  // Android snapshots Recents as the app leaves, too early to count on the cover, so with the lock
  // on the whole app is FLAG_SECURE: a blank thumbnail, and no screenshots (AUTH-12).
  useBlockScreenCapture('private', enabled);
  // iOS: the cover below is a JS render; a native blur covers the snapshot even when JS is late.
  useAppSwitcherProtection(enabled);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => appStateChanged(state));
    return () => subscription.remove();
  }, []);

  // Opens the OS prompt on its own when the lock engages in the foreground.
  useEffect(() => {
    if (!locked) {
      prompted.current = false;
      return;
    }
    if (prompted.current || AppState.currentState !== 'active') return;
    prompted.current = true;
    promptUnlock();
  }, [locked, covered]);

  if (!enabled || (!locked && !covered)) return null;
  return (
    <TopOverlay key={Platform.OS === 'ios' ? layer : undefined}>
      <View
        className={cn('flex-1 items-center justify-center gap-6 px-8', tw.bg)}
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        testID="app-lock"
        accessibilityViewIsModal
      >
        <Image source={icon} style={{ width: 72, height: 72, borderRadius: 16 }} accessibilityIgnoresInvertColors />
        <Text variant="headline" tone="emphasis" accessibilityRole="header">
          {copy.lock.title}
        </Text>
        {locked ? (
          <Button label={copy.lock.unlock} size="lg" onPress={promptUnlock} testID="app-lock-unlock" />
        ) : null}
      </View>
    </TopOverlay>
  );
}
