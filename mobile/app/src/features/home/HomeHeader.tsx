import { Alert, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import type { EngineState as SupervisorState } from '~/engine/supervisor';
import { cn } from '~/lib-allowlist';
import { NetworkChip, type EngineState } from '~/ui/NetworkChip';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/** UX_SPEC §5.11 (web's network banner copy). */
const NETWORK_COPY: Record<string, { title: string; body: string }> = {
  devnet: { title: 'Devnet', body: 'Running on a Dash Platform devnet. Data may be reset.' },
  testnet: { title: 'Testnet', body: 'Running on Dash Platform Testnet. Data may be reset.' },
};

/** The chip's three looks for the supervisor's states. */
export function chipState(state: SupervisorState): EngineState {
  if (state === 'ready' || state === 'degraded') return 'ready';
  if (state === 'failed' || state === 'unsupported' || state === 'crashed') return 'unavailable';
  return 'booting';
}

function HomeNetworkChip() {
  const { state } = useEngineStatus();
  const copy = NETWORK_COPY[config.network];
  return (
    <NetworkChip
      network={config.network}
      state={chipState(state)}
      onPress={copy ? () => Alert.alert(copy.title, copy.body) : undefined}
    />
  );
}

/** The navigation bar's height: 44 pt on iOS, Material 3's 64 dp app bar on Android. */
const BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 64;

/**
 * Home's inline header (UX_SPEC §4.8): the web sidebar's "Yappr" wordmark
 * (`text-2xl font-bold`; its yappr-500 → 600 gradient drawn solid), with the
 * network chip after it on iOS and as a trailing action on Android. Drawn by
 * the screen rather than the native stack header, whose iOS bar buttons sit
 * in their own glass capsules.
 */
export function HomeHeader() {
  const { top } = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';
  return (
    <View style={{ paddingTop: top }} className={tw.bg} testID="home-header">
      <View
        style={{ height: BAR_HEIGHT }}
        className={cn('flex-row items-center gap-2 px-4', ios ? 'justify-start' : 'justify-between')}
      >
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.3}
          className="text-2xl font-bold text-yappr-600 dark:text-yappr-500"
        >
          Yappr
        </Text>
        {/* The chip aligns itself to the start; its own row centers it on the wordmark. */}
        <View className="flex-row items-center">
          <HomeNetworkChip />
        </View>
      </View>
    </View>
  );
}
