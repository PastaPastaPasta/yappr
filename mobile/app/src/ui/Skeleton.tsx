import { useEffect, type ReactNode } from 'react';
import { View, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from '~/lib-allowlist';

import { motion, tw } from './tokens';

const PULSE_EASING = Easing.bezier(0.4, 0, 0.6, 1);

/** The web's `animate-pulse`: opacity 1 → 0.5 → 1 every 2 s; still under Reduce Motion. */
function usePulse() {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return undefined;
    opacity.set(withRepeat(withTiming(0.5, { duration: motion.pulse / 2, easing: PULSE_EASING }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

export interface SkeletonProps {
  width?: DimensionValue;
  /** 12 for caption / subhead lines, 16 for body (UX_SPEC §2.15). */
  height?: number;
  /** A circle of `height` diameter instead of a bar. */
  circle?: boolean;
  className?: string;
}

/** One pulsing placeholder bar or circle in `bg.skeleton`. */
export function Skeleton({ width = '100%', height = 12, circle = false, className }: SkeletonProps) {
  const pulse = usePulse();
  // className stays on a plain View: NativeWind does not style Reanimated's components.
  return (
    <Animated.View style={[{ width: circle ? height : width, height }, pulse]}>
      <View className={cn('flex-1 rounded-full', tw.bgSkeleton, className)} />
    </Animated.View>
  );
}

/** A loading container: hidden from screen readers except one "Loading" label. */
function SkeletonGroup({ children, className, testID }: { children: ReactNode; className?: string; testID?: string }) {
  return (
    <View accessible accessibilityLabel="Loading" className={className} testID={testID}>
      {children}
    </View>
  );
}

/** UX_SPEC §2.15 post skeleton: avatar, two header bars, three body bars, four action circles. */
export function PostSkeleton() {
  return (
    <SkeletonGroup className={cn('flex-row gap-3 border-b px-4 pb-3 pt-3', tw.border)} testID="post-skeleton">
      <Skeleton circle height={48} />
      <View className="flex-1 gap-2">
        <View className="flex-row gap-2">
          <Skeleton width={96} />
          <Skeleton width={64} />
        </View>
        <Skeleton height={16} />
        <Skeleton height={16} width="92%" />
        <Skeleton height={16} width="60%" />
        <View className="mt-1 flex-row justify-between pr-12">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} circle height={20} />
          ))}
        </View>
      </View>
    </SkeletonGroup>
  );
}

/** User, notification and conversation rows: a 40 circle and two bars, plus a time bar for conversations. */
export function RowSkeleton({ withTime = false }: { withTime?: boolean }) {
  return (
    <SkeletonGroup className="min-h-[72px] flex-row items-center gap-3 px-4 py-3" testID="row-skeleton">
      <Skeleton circle height={40} />
      <View className="flex-1 gap-2">
        <Skeleton width="50%" />
        <Skeleton width="80%" />
      </View>
      {withTime ? <Skeleton width={32} /> : null}
    </SkeletonGroup>
  );
}
