import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { useEngineStatus } from './hooks';
import { engineSupervisor } from './index';

/** UX_SPEC §6 copy: `engine.couldntConnect`, `lockdown.banner`. */
export const ENGINE_BANNER_COPY = {
  couldntConnect: "Couldn't connect to Dash Platform.",
  lockdown: "Lockdown Mode is on. You're browsing saved posts.",
} as const;

/**
 * UX_SPEC §2.18, §4.33, §4.34 (PRD NET-01, NET-04, NET-06): under the
 * navigation bar while the engine cannot reach Dash Platform, so the saved
 * content stays browsable with a way back.
 *
 * - `failed` (the supervisor gave up): "Couldn't connect" with "Try again"
 *   (a fresh engine).
 * - `degraded` (its boot failed, NET-01) while the phone is online:
 *   "Couldn't connect" with "Try again" (boot again now; the supervisor also
 *   retries by itself). Offline, the offline banner says it instead.
 * - Lockdown Mode: the browsing-saved-posts banner, "Fix" back to its screen.
 * - An outdated Android WebView: "Couldn't connect", "Fix" back to its screen.
 */
export function EngineBanner() {
  const { state, unsupported } = useEngineStatus();
  const offline = useNetInfo().isConnected === false;
  let banner: { text: string; action: string; onPress: () => void } | null = null;
  if (state === 'failed') {
    banner = {
      text: ENGINE_BANNER_COPY.couldntConnect,
      action: 'Try again',
      onPress: () => engineSupervisor.restart('Try again (banner)'),
    };
  } else if (state === 'degraded' && !offline) {
    banner = {
      text: ENGINE_BANNER_COPY.couldntConnect,
      action: 'Try again',
      onPress: () => engineSupervisor.retryBootNow(),
    };
  } else if (state === 'unsupported') {
    const lockdown = unsupported === 'lockdown';
    banner = {
      text: lockdown ? ENGINE_BANNER_COPY.lockdown : ENGINE_BANNER_COPY.couldntConnect,
      action: 'Fix',
      onPress: () => router.push(lockdown ? '/lockdown' : '/webview-update'),
    };
  }
  if (!banner) return null;
  return (
    <View
      accessibilityRole="alert"
      testID="engine-banner"
      className={cn('min-h-11 flex-row items-center justify-between gap-3 px-4 py-2', tw.errorBg)}
    >
      <Text variant="subhead" className="flex-1">
        {banner.text}
      </Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={banner.onPress} testID="engine-banner-action">
        <Text variant="subheadStrong" tone="link">
          {banner.action}
        </Text>
      </Pressable>
    </View>
  );
}
