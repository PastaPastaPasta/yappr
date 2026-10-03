import { useReducedMotion, type CSSAnimationProperties } from 'react-native-reanimated';

/**
 * A looping animation (a skeleton's pulse, the network dot, the wallet glyph)
 * as a Reanimated CSS keyframe animation: `style={[base, usePulse(PULSE)]}`
 * on an `Animated.View`. Nothing under Reduce Motion, or when `active` is false.
 *
 * Never an endless `withRepeat` on a shared value behind `useAnimatedStyle` for
 * these (D-L3a-010). Every frame of such a loop writes the view's props into
 * Reanimated's animated-props registry, and when the view unmounts mid-loop
 * (a skeleton replaced by the content it stood for), its entry outlives the
 * native view until the loop is stopped and Reanimated sweeps settled props.
 * On Android, any event dispatched during a draw pass (react-native-svg
 * dispatches one per element the first time it draws) makes Reanimated
 * re-apply that whole registry synchronously, so every SVG avatar arriving
 * with the content logged a stack trace per stale skeleton: ~10k
 * "synchronouslyUpdateUIProps failed" traces in 30 minutes. CSS animations
 * are interpolated in C++, never enter that registry, and cost no worklet
 * call per frame.
 */
export function usePulse<A extends CSSAnimationProperties>(animation: A, active = true): A | undefined {
  const reduceMotion = useReducedMotion();
  return active && !reduceMotion ? animation : undefined;
}
