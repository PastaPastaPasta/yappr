import { useEffect, useRef } from 'react';
import { AppState, Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cn } from '~/lib-allowlist';
import { errorFeedback } from '~/ui/haptics';
import { Button } from '~/ui/Button';
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
    <TopOverlay>
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
