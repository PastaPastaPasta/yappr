import { TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { PaperAirplaneIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { ScalePressable } from '~/ui/ScalePressable';
import { GrowMirror, useGrowHeight } from '~/ui/grow';
import { InputSlot } from '~/ui/InputSlot';
import { useNativeText } from '~/ui/native-text';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { colors, hitSlopFor, tw, useColors } from '~/ui/tokens';

const LINE = 22;
/** paddingTop + paddingBottom. */
const PADDING = 18;
const MAX_LINES = 5;

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  /** Sends the text; true when it took it (the box is then emptied at once). */
  onSend: () => boolean;
  disabled?: boolean;
}

/**
 * The message composer (UX_SPEC §4.20, PRD DM-04): "Type a message...",
 * growing to 5 lines then scrolling, and a round send button enabled when
 * there is visible text. The screen pads it above the keyboard or the
 * home indicator. The input is uncontrolled (`useNativeText`), so no
 * keystroke is lost; the draft clearing after a send, or coming back into the
 * box, is put in. A send empties the box from the tap itself, with a fresh
 * input: the old one's late keystroke events would bring the sent text back
 * with them (QA rc9 c2: a second Send sent the first message again). The old
 * input stays, hidden by its slot (`InputSlot`), until the new one has the
 * focus, so the keyboard stays up (QA rc11 c3, rc12 c1).
 */
export function Composer({ value, onChangeText, onSend, disabled = false }: ComposerProps) {
  const c = useColors();
  const scale = useWindowDimensions().fontScale;
  const { key: inputKey, attach, clear, inputProps, retiring, focused } = useNativeText({ value, onChangeText, editable: !disabled });
  /** The same input for the live box and the one it replaced: only its handlers, text and test id differ. */
  const field = (props: TextInputProps, testID: string, ref?: (input: TextInput | null) => void) => (
    <TextInput
      ref={ref}
      {...props}
      placeholder="Type a message..."
      placeholderTextColor={c.textPlaceholder}
      accessibilityLabel="Message"
      multiline
      editable={!disabled}
      cursorColor={c.accent}
      selectionColor={c.accent}
      className="text-gray-900 dark:text-gray-100"
      style={inputStyle}
      testID={testID}
    />
  );
  // The line height as given: React Native scales it with the font, as it does the font size, so a
  // line is `LINE * scale` tall on screen, and that is what the box is measured in (QA rc14 c3).
  const textStyle = { fontSize: 16, lineHeight: LINE };
  const lineOnScreen = LINE * scale;
  const minHeight = Math.max(40, lineOnScreen + PADDING);
  const maxHeight = lineOnScreen * MAX_LINES + PADDING;
  // Grows a line at a time up to 5 full lines, then scrolls (UX_SPEC §4.20); iOS needs the measured height (`useGrowHeight`).
  const grow = useGrowHeight({ min: minHeight, max: maxHeight, padding: PADDING });
  const inputStyle = {
    ...textStyle,
    minHeight,
    maxHeight,
    height: grow.height,
    paddingTop: 9,
    paddingBottom: 9,
    textAlignVertical: 'center' as const,
  };
  const send = () => {
    if (onSend()) clear();
  };
  const canSend = !disabled && value.trim().length > 0;

  const sendRipple = useRipple('fill');
  return (
    <View
      className={cn('flex-row items-end gap-2 border-t px-3 py-2', tw.border, tw.bg)}
    >
      <View
        className={cn(
          'flex-1 justify-center rounded-3xl border px-4',
          focused ? 'border-yappr-500' : tw.borderStrong,
          tw.bg,
        )}
      >
        {retiring ? (
          // The input that held the sent text, until the fresh one below has the focus. Hidden by its
          // slot only: its own props stay as they were, so it keeps the keyboard until then.
          <InputSlot key={retiring.key} retired>
            {field(retiring.inputProps, 'dm-composer-retiring')}
          </InputSlot>
        ) : null}
        <InputSlot key={inputKey}>
          {field(inputProps, 'dm-composer', attach)}
          <GrowMirror text={value} style={textStyle} onLayout={grow.onMirrorLayout} testID="dm-composer-mirror" />
        </InputSlot>
      </View>
      <ScalePressable
        android_ripple={sendRipple}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={send}
        hitSlop={hitSlopFor(40)}
        className={cn(
          'mb-0.5 h-10 w-10 items-center justify-center rounded-full android:overflow-hidden',
          canSend ? tw.accentFill : 'bg-gray-200 dark:bg-gray-800',
        )}
        testID="dm-send"
      >
        <PaperAirplaneIcon size={18} color={canSend ? colors.white : c.textDisabled} />
      </ScalePressable>
    </View>
  );
}

/** Shown instead of the composer (the screen adds the bottom inset) when the user can't send (DM-08, DM-10): `bg.muted`, centered `subhead`. */
export function ComposerBanner({ text }: { text: string }) {
  return (
    <View
      className={cn('items-center border-t px-6 py-4', tw.border, tw.bgMuted)}
      testID="dm-composer-banner"
    >
      <Text variant="subhead" tone="secondary" className="text-center">
        {text}
      </Text>
    </View>
  );
}
