import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { motion } from './tokens';

export interface ScalePressableProps extends PressableProps {
  /** Pressed scale; web `interactive-scale` is 0.98, the FAB 0.95. */
  pressedScale?: number;
  className?: string;
  /** Style for the outer (scaling) wrapper, e.g. `alignSelf` or `flex`. */
  wrapperStyle?: StyleProp<ViewStyle>;
}

/**
 * A Pressable that shrinks slightly while held (`duration.fast`), the web's
 * `interactive-scale`. Reduce Motion turns the scale off.
 */
export function ScalePressable({
  pressedScale = 0.98,
  wrapperStyle,
  onPressIn,
  onPressOut,
  disabled,
  ...props
}: ScalePressableProps) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const animate = !reduceMotion && !disabled;

  return (
    <Animated.View style={[wrapperStyle, animatedStyle]}>
      <Pressable
        disabled={disabled}
        onPressIn={(e) => {
          if (animate) scale.set(withTiming(pressedScale, { duration: motion.fast }));
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          if (animate) scale.set(withTiming(1, { duration: motion.fast }));
          onPressOut?.(e);
        }}
        {...props}
      />
    </Animated.View>
  );
}
