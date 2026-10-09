import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/** A live slot in a row: it takes the input's place (`flex-1`); the input fills it. */
export const INPUT_SLOT: ViewStyle = { flex: 1 };

/** Out of the layout, out of sight and out of reach (nothing to hit in no size), without touching the input. */
const RETIRED: ViewStyle = { position: 'absolute', left: 0, right: 0, top: 0, height: 0, overflow: 'hidden', opacity: 0 };

export interface InputSlotProps {
  /** The input inside is the one a reset replaced (`useNativeText`'s `retiring`). */
  retired?: boolean;
  /** The slot's style while live: where the input sits in its row. */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * The view each text input of `useNativeText` sits in, keyed by its mount
 * (QA rc12 c1). A reset hides the replaced input by its slot alone: the
 * input's own props stay as they were until the fresh one has the focus,
 * since on iOS turning off a first responder's interaction
 * (`pointerEvents`, which sets `userInteractionEnabled`) resigns it, and the
 * keyboard starts to close before the fresh input takes over. The slot is
 * never flattened, so the input never changes native parent (a reparented
 * input is a new native view, which resigns too).
 */
export function InputSlot({ retired = false, style, children }: InputSlotProps) {
  return (
    <View
      collapsable={false}
      style={retired ? RETIRED : style}
      accessibilityElementsHidden={retired}
      importantForAccessibility={retired ? 'no-hide-descendants' : 'auto'}
    >
      {children}
    </View>
  );
}
