import { useImperativeHandle, useState, type Ref } from 'react';
import { TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { EyeIcon, EyeSlashIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { IconButton } from './IconButton';
import { INPUT_SLOT, InputSlot } from './InputSlot';
import { useNativeText, type TextResetHandle } from './native-text';
import { Text } from './Text';
import { tw, useColors } from './tokens';

/** The counter shows once the text is this close to `maxLength` (UX_SPEC §2.11). */
const COUNTER_WITHIN = 20;
const BODY_LINE_HEIGHT = 24;
/** Secrets never reach autofill, the keyboard's dictionary or autocorrect. */
const SECURE_INPUT: TextInputProps = {
  autoCorrect: false,
  autoCapitalize: 'none',
  autoComplete: 'off',
  textContentType: 'none',
  importantForAutofill: 'no',
};

export interface TextFieldProps extends Omit<TextInputProps, 'multiline' | 'secureTextEntry'> {
  label?: string;
  error?: string;
  /** A key or secret: hidden, with a show / hide button, and no autofill or correction. */
  secure?: boolean;
  /** Multi-line: min 3 lines, grows to 8, then scrolls. */
  multiline?: boolean;
  /** Show the `maxLength` counter from the first character ("0 / 500"), not only near the limit. */
  alwaysCount?: boolean;
  className?: string;
  /** `reset(value)`: sets the text for an action of the user's (Clear, Randomize), before the caller's value follows. */
  ref?: Ref<TextResetHandle>;
}

/**
 * Text field and text area (components/ui/input.tsx, textarea.tsx): a
 * `border.strong` outline that turns into a 2 pt `accent` ring on focus (the
 * web's purple ring is not used, ADR E3), `error` border and message below.
 *
 * `value` and `onChangeText` work as on a TextInput, but the native input is
 * uncontrolled so no keystroke is lost (`useNativeText`): a `value` other
 * than the typed text (a reset) is put in, while `value` echoing the typing
 * never is. Keeping the old `value` does not refuse a keystroke.
 */
export function TextField({
  label,
  error,
  secure = false,
  multiline = false,
  alwaysCount = false,
  maxLength,
  value,
  onChangeText,
  editable = true,
  className,
  onFocus,
  onBlur,
  autoFocus,
  ref,
  ...props
}: TextFieldProps) {
  const c = useColors();
  const { key: inputKey, attach, reset, inputProps, retiring, focused } = useNativeText({
    value,
    onChangeText,
    onFocus,
    onBlur,
    autoFocus,
    editable,
  });
  useImperativeHandle(ref, () => ({ reset }), [reset]);
  const [revealed, setRevealed] = useState(false);
  const line = BODY_LINE_HEIGHT * useWindowDimensions().fontScale;
  const length = value?.length ?? 0;
  const showCounter = maxLength !== undefined && (alwaysCount || maxLength - length <= COUNTER_WITHIN);
  const inputStyle = multiline
    ? {
        fontSize: 16,
        minHeight: line * 3 + 20,
        maxHeight: line * 8 + 20,
        paddingVertical: 10,
        textAlignVertical: 'top' as const,
      }
    : { fontSize: 16, minHeight: Math.max(42, line + 18), paddingVertical: 0 };
  let borderColor: string = tw.borderStrong;
  if (error) borderColor = 'border-red-600 dark:border-red-400';
  else if (focused) borderColor = 'border-yappr-500';

  /** The live input and the one a reset replaced: the same input, but for its handlers, text and test id. */
  const field = (fieldProps: TextInputProps, live: boolean) => (
    <TextInput
      ref={live ? attach : undefined}
      accessibilityLabel={label}
      accessibilityHint={error}
      maxLength={maxLength}
      editable={editable}
      multiline={multiline}
      secureTextEntry={secure && !revealed}
      placeholderTextColor={c.textPlaceholder}
      cursorColor={c.accent}
      selectionColor={c.accent}
      {...(secure ? SECURE_INPUT : null)}
      {...props}
      testID={live ? props.testID : undefined}
      {...fieldProps}
      // fontSize without text-base's lineHeight: iOS mis-lays out single-line inputs with one.
      className="text-gray-900 dark:text-gray-100"
      style={inputStyle}
    />
  );
  return (
    <View className={cn('gap-1.5', className)}>
      {label ? <Text variant="subheadStrong">{label}</Text> : null}
      <View
        // Always the input's native parent. Otherwise Fabric hoists the input out of this box while
        // it is opaque and back in while it is dimmed (not editable), and on Android that move
        // crashes inside a screen that is animating out (mobile/CLAUDE.md, "Native view structure").
        collapsable={false}
        className={cn(
          'flex-row items-center rounded-lg',
          tw.bg,
          // A 2 pt border with 11 pt padding keeps the text where the 1 pt state has it.
          focused || error ? 'border-2 px-[11px]' : 'border px-3',
          borderColor,
          !editable && 'opacity-50',
        )}
      >
        {retiring ? (
          // The input a reset replaced, until the fresh one has the focus: hidden by its slot alone.
          <InputSlot key={retiring.key} retired>
            {field(retiring.inputProps, false)}
          </InputSlot>
        ) : null}
        <InputSlot key={inputKey} style={INPUT_SLOT}>
          {field(inputProps, true)}
        </InputSlot>
        {secure ? (
          <IconButton
            icon={revealed ? EyeSlashIcon : EyeIcon}
            accessibilityLabel={revealed ? 'Hide key' : 'Show key'}
            onPress={() => setRevealed((r) => !r)}
            className="-mr-2"
          />
        ) : null}
      </View>
      {error || showCounter ? (
        <View className="flex-row gap-2">
          <Text variant="caption" tone="error" className="flex-1" accessibilityLiveRegion="polite">
            {error ?? ''}
          </Text>
          {showCounter ? (
            <Text variant="caption" tone={length > maxLength ? 'error' : 'secondary'} tabular>
              {length} / {maxLength}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
