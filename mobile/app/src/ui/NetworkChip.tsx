import { Pressable, View } from 'react-native';
import Animated, { type CSSAnimationProperties } from 'react-native-reanimated';

import { cn } from '~/lib-allowlist';

import { usePulse } from './pulse';
import { Text } from './Text';
import { colors, hitSlopFor, motion } from './tokens';

export type ChipNetwork = 'devnet' | 'testnet' | 'mainnet';
export type EngineState = 'ready' | 'booting' | 'unavailable';

const STATE_WORD: Record<EngineState, string> = {
  ready: 'ready',
  booting: 'connecting',
  unavailable: 'unavailable',
};

/** UX_SPEC §5.13: "Devnet. Data may be reset. Engine ready." */
function networkChipLabel(network: Exclude<ChipNetwork, 'mainnet'>, state: EngineState): string {
  const name = network === 'devnet' ? 'Devnet' : 'Testnet';
  return `${name}. Data may be reset. Engine ${STATE_WORD[state]}.`;
}

/** The dot's pulse: opacity 1 ↔ 0.3, a second each way. */
const DOT_PULSE = {
  animationName: { from: { opacity: 1 }, to: { opacity: 0.3 } },
  animationDuration: motion.pulse / 2,
  animationDirection: 'alternate',
  animationIterationCount: 'infinite',
  animationTimingFunction: 'ease-in-out',
} satisfies CSSAnimationProperties;

/** The 6 pt dot: steady when ready, pulsing while booting, hollow when unavailable. */
function StateDot({ state }: { state: EngineState }) {
  const style = usePulse(DOT_PULSE, state === 'booting');
  return (
    <Animated.View style={style}>
      <View
        testID={`network-dot-${state}`}
        className={cn('h-1.5 w-1.5 rounded-full border border-black', state !== 'unavailable' && 'bg-black')}
      />
    </Animated.View>
  );
}

export interface NetworkChipProps {
  network: ChipNetwork;
  state: EngineState;
  /** Opens the network sheet (UX_SPEC §4.34). */
  onPress?: () => void;
}

/** The amber DEVNET / TESTNET chip (UX_SPEC §2.17). Nothing on mainnet. */
export function NetworkChip({ network, state, onPress }: NetworkChipProps) {
  if (network === 'mainnet') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={networkChipLabel(network, state)}
      hitSlop={hitSlopFor(20)}
      onPress={onPress}
      disabled={!onPress}
      testID="network-chip"
      className="min-h-5 flex-row items-center gap-1.5 self-start rounded-full bg-amber-500 px-2 active:opacity-80"
    >
      <StateDot state={state} />
      <Text variant="chip" style={{ color: colors.black }} maxFontSizeMultiplier={1.5}>
        {network}
      </Text>
    </Pressable>
  );
}
