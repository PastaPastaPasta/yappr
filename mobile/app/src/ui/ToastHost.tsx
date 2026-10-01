import { useEffect } from 'react';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { CheckCircleIcon, XCircleIcon } from 'react-native-heroicons/solid';
import Animated, { FadeOut, Keyframe } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from './Text';
import { useToastStore, type ToastItem } from './toast';
import { colors, motion } from './tokens';

/** In: fade and slide down 10 pt (`duration.base`). Out: fade (`duration.fast`). */
const ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -10 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
}).duration(motion.base);
const EXIT = FadeOut.duration(motion.fast);

/** Clears the standard navigation bar, so toasts sit just under it (UX_SPEC §2.14). */
const NAV_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;
const SWIPE_DISMISS = -20;

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(item.message);
    const timer = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item, dismiss]);

  const swipeUp = Gesture.Pan()
    .runOnJS(true)
    .onEnd((e) => {
      if (e.translationY < SWIPE_DISMISS) dismiss(item.id);
    });

  return (
    <GestureDetector gesture={swipeUp}>
      <Animated.View entering={ENTER} exiting={EXIT} style={{ maxWidth: '100%' }}>
        <View
          testID="toast"
          accessibilityRole="alert"
          className="flex-row items-center gap-2.5 rounded-lg bg-gray-800 px-4 py-3 shadow-lg"
        >
          {item.kind === 'success' ? <CheckCircleIcon size={18} color={colors.green500} /> : null}
          {item.kind === 'error' ? <XCircleIcon size={18} color={colors.red500} /> : null}
          <Text variant="subhead" tone="inverse" className="shrink">
            {item.message}
          </Text>
          {item.action ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => {
                item.action?.onPress();
                dismiss(item.id);
              }}
              testID="toast-action"
            >
              <Text variant="subheadStrong" style={{ color: colors.yappr300 }}>
                {item.action.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * Renders the current toast, top-center below the navigation bar, in the
 * same dark colors in both themes (as web). Mount it once, above the
 * navigator. `top` overrides the offset when it is mounted inside a screen.
 */
export function ToastHost({ top }: { top?: number }) {
  const current = useToastStore((s) => s.current);
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: top ?? insets.top + NAV_BAR_HEIGHT + 8,
        left: 16,
        right: 16,
        alignItems: 'center',
      }}
    >
      {current ? <ToastView key={current.id} item={current} /> : null}
    </View>
  );
}
