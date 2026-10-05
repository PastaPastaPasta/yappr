import { TextInput, View, useWindowDimensions } from 'react-native';
import { PaperAirplaneIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';
import { ScalePressable } from '~/ui/ScalePressable';
import { useNativeText } from '~/ui/native-text';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { colors, hitSlopFor, tw, useColors } from '~/ui/tokens';

const LINE = 22;
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
 * with them (QA rc9 c2: a second Send sent the first message again).
 */
export function Composer({ value, onChangeText, onSend, disabled = false }: ComposerProps) {
  const c = useColors();
  const scale = useWindowDimensions().fontScale;
  const { key: inputKey, attach, clear, inputProps, focused } = useNativeText({ value, onChangeText, editable: !disabled });
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
        <TextInput
          key={inputKey}
          ref={attach}
          {...inputProps}
          placeholder="Type a message..."
          placeholderTextColor={c.textPlaceholder}
          accessibilityLabel="Message"
          multiline
          editable={!disabled}
          cursorColor={c.accent}
          selectionColor={c.accent}
          className="text-gray-900 dark:text-gray-100"
          style={{
            fontSize: 16,
            lineHeight: LINE * scale,
            minHeight: 40,
            maxHeight: LINE * scale * MAX_LINES + 16,
            paddingTop: 9,
            paddingBottom: 9,
            textAlignVertical: 'center',
          }}
          testID="dm-composer"
        />
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
