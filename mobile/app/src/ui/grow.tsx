import { useState } from 'react';
import { Platform, Text, type LayoutChangeEvent, type TextStyle } from 'react-native';

/**
 * Multi-line inputs grow with their text on iOS (QA rc13 c6).
 *
 * Fabric sizes a TextInput by its native text only once its state has been
 * seeded from the React tree (`BaseTextInputShadowNode`'s
 * `attributedStringBoxToMeasure`: the state's react-tree string must carry
 * the layout's font size multiplier, which defaults to NaN). The state is
 * seeded when the input's `text` prop changes. An uncontrolled input
 * (`useNativeText`) that mounts empty never changes it: an empty string and
 * the initial state compare equal, so iOS keeps measuring the empty
 * `defaultValue`, one line, whatever is typed. (Android measures the text
 * the field holds, `cachedAttributedStringId`, and grows by itself.)
 *
 * So on iOS the height comes from an invisible copy of the text, laid out
 * by the same TextKit at the input's width with its font and line height
 * (the input's text container has no line fragment padding): `GrowMirror`
 * reports its height, and `height` is the input's, between `min` and `max`.
 */
export function useGrowHeight({ min, max, padding }: { min: number; max: number; padding: number }) {
  const [measured, setMeasured] = useState<number | null>(null);
  const height =
    Platform.OS === 'ios' && measured !== null ? Math.min(max, Math.max(min, Math.ceil(measured) + padding)) : undefined;
  const onMirrorLayout = (event: LayoutChangeEvent) => setMeasured(event.nativeEvent.layout.height);
  return { height, onMirrorLayout };
}

/** Out of sight, reach and accessibility, at the input's width (it sits beside it, in its slot). */
const MIRROR: TextStyle = { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 };

/**
 * The invisible copy of an input's text that `useGrowHeight` measures, iOS
 * only. A trailing line break counts as a line, as it does in the input.
 */
export function GrowMirror({
  text,
  style,
  onLayout,
  testID,
}: {
  text: string;
  style: TextStyle;
  onLayout: (event: LayoutChangeEvent) => void;
  testID?: string;
}) {
  if (Platform.OS !== 'ios') return null;
  const shown = text === '' || text.endsWith('\n') ? `${text}​` : text;
  return (
    <Text
      style={[style, MIRROR]}
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={testID}
    >
      {shown}
    </Text>
  );
}
