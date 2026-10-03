import { Pressable, View } from 'react-native';
import Animated, { type CSSAnimationProperties } from 'react-native-reanimated';

import type { EngineState as SupervisorState } from '~/engine/supervisor';
import { cn } from '~/lib-allowlist';

import { usePulse } from './pulse';
import { Text } from './Text';
import { colors, hitSlopFor, motion } from './tokens';

export type ChipNetwork = 'devnet' | 'testnet' | 'mainnet';
export type EngineState = 'ready' | 'booting' | 'unavailable';

/**
 * The chip's look for the supervisor's state (PRD NET-01, UX_SPEC §2.17):
 * steady once booted, hollow when the engine could not connect (a degraded
 * boot, or it gave up), pulsing while it starts.
 */
export function chipStateOf(state: SupervisorState): EngineState {
  if (state === 'ready') return 'ready';
  if (state === 'degraded' || state === 'failed' || state === 'unsupported' || state === 'crashed') return 'unavailable';
  return 'booting';
}

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
      {/*
        Never truncated (D-L3a-008). Android sizes a label to its unbroken width, then lays it
        out with the high-quality line breaker, which can want a hair more room for bold,
        letter-spaced text at some densities (280 dpi): the last letter wraps onto a second
        line that the one-line chip clips ("DEVNE"). The simple breaker fits the width it was
        measured at. The label is uppercased here and `normal-case` drops the chip token's
        `uppercase`, so no text transform sits between the two.
      */}
      <Text
        variant="chip"
        className="normal-case"
        style={{ color: colors.black }}
        maxFontSizeMultiplier={1.5}
        textBreakStrategy="simple"
        testID="network-chip-label"
      >
        {network.toUpperCase()}
      </Text>
    </Pressable>
  );
}
