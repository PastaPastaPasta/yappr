import { useState } from 'react';
import {
  Platform,
  Text,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextStyle,
} from 'react-native';

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
 * the field holds, `cachedAttributedStringId`, but loses it as easily:
 * `useContentGrowHeight`.)
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

/**
 * Android sizes a multi-line input by Fabric's measure of the text the field
 * holds, which the field hands over with each keystroke
 * (`AndroidTextInputState.cachedAttributedStringId`). Any change to the text
 * the React tree gives it drops that hand-over: a new text size (the font
 * scale feeds every fragment's `fontSizeMultiplier`) or a new text colour
 * makes `AndroidTextInputShadowNode::updateStateIfNeeded` start a fresh state
 * holding the tree's own text, the `defaultValue` an uncontrolled input
 * mounted with (`useNativeText`), so the box measures as one empty line,
 * however much is typed, until the next keystroke (QA rc16 A-08).
 *
 * So on Android the height comes from what the field itself has laid out,
 * `onContentSizeChange` (its text layout plus its padding), between `min` and
 * `max`. `input` is the live input's key: a size reported by an input that
 * has since been replaced (a sent message) is not the fresh one's.
 */
export function useContentGrowHeight({ min, max, input }: { min: number; max: number; input: unknown }) {
  const [content, setContent] = useState<{ input: unknown; height: number } | null>(null);
  const height =
    Platform.OS === 'android' && content !== null && content.input === input
      ? Math.min(max, Math.max(min, Math.ceil(content.height)))
      : undefined;
  /** The handler for the input keyed `from` (Android only): a replaced input keeps its own. */
  const onContentSizeChange = (from: unknown) =>
    Platform.OS === 'android'
      ? (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
          setContent({ input: from, height: event.nativeEvent.contentSize.height })
      : undefined;
  return { height, onContentSizeChange };
}

/**
 * Android only: invisible `lines` lines of `style`'s text, laid out as the
 * input lays out its own, for the height of that many lines on screen at the
 * current font scale. (An Android input draws typed text without the
 * `lineHeight` it is given, which only Fabric's measuring copy carries, so a
 * capped input there is given none, and its lines are measured here.)
 */
export function LinesMirror({
  lines,
  style,
  onLayout,
  testID,
}: {
  lines: number;
  style: TextStyle;
  onLayout: (event: LayoutChangeEvent) => void;
  testID?: string;
}) {
  if (Platform.OS !== 'android') return null;
  return (
    <Text
      style={[style, MIRROR]}
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={testID}
    >
      {Array.from({ length: lines }, () => '\u200b').join('\n')}
    </Text>
  );
}
