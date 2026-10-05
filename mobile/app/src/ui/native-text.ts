import { useState } from 'react';
import type { TextInputProps } from 'react-native';

/**
 * Text inputs here are uncontrolled (QA rc7 D-2). A `value` TextInput has
 * JS push its text back to the native field after every keystroke, and on
 * the New Architecture that echo can land after the user has typed on:
 * under a busy JS thread (Edit profile re-renders its whole form per key,
 * the member picker searches) fields lost keystrokes, at the end or in the
 * middle ("rc7i" saved as "r7i"). React Native's own docs advise
 * `defaultValue` (react-native-website#4247). Compose, which hands its
 * input children instead of a `value`, never dropped one.
 *
 * So the native field owns the text, and JS only listens. The caller keeps
 * its `value` and `onChangeText`: a `value` that is not what the field last
 * reported (a reset, a cleared search, "Randomize") is a programmatic change,
 * put in by mounting a fresh input with it as `defaultValue` (it takes the
 * focus the old one had). A `value` the field has since typed past is a
 * render from before the latest keystrokes reached the caller, and changes
 * nothing. So a caller cannot refuse a keystroke by keeping its old `value`
 * (no caller does): limit the input with its own props (`maxLength`) instead.
 */

interface Held {
  /** The input's `defaultValue`; `generation` is its `key`, bumped to mount it afresh with a new text. */
  initial: string | undefined;
  generation: number;
  /** Whether the input it replaced had focus, so the new one takes it. */
  refocus: boolean;
  /** The text the native field holds, as far as JS has heard. */
  text: string | undefined;
  /** Texts the field held before `text` that the caller's `value` may still show. */
  behind: readonly string[];
}

export interface NativeText {
  /** The TextInput's `key`. */
  key: number;
  /** Spread on the TextInput (in place of `value`). Its own `onChangeText`, `onFocus` and `onBlur` are these. */
  inputProps: Pick<TextInputProps, 'defaultValue' | 'autoFocus' | 'onChangeText' | 'onFocus' | 'onBlur'>;
  focused: boolean;
}

export type NativeTextOptions = Pick<
  TextInputProps,
  'value' | 'onChangeText' | 'onFocus' | 'onBlur' | 'autoFocus' | 'editable'
>;

export function useNativeText({ value, onChangeText, onFocus, onBlur, autoFocus, editable }: NativeTextOptions): NativeText {
  const [focused, setFocused] = useState(false);
  const [held, setHeld] = useState<Held>(() => ({ initial: value, generation: 0, refocus: false, text: value, behind: [] }));

  // Adjusted while rendering, so the caller's value and the field's text are compared from one render.
  if (value !== undefined && value !== held.text) {
    if (!held.behind.includes(value)) {
      // A field that is locked (a form saving, a sign-in going through) does not take the focus back.
      setHeld({ initial: value, generation: held.generation + 1, refocus: focused && editable !== false, text: value, behind: [] });
      // The input that had it is gone; the new one says so itself when it takes it.
      setFocused(false);
    }
  } else if (held.behind.length > 0) {
    // The caller caught up with the field.
    setHeld({ ...held, behind: [] });
  }

  return {
    key: held.generation,
    focused,
    inputProps: {
      defaultValue: held.initial,
      autoFocus: held.generation === 0 ? autoFocus : held.refocus,
      onChangeText: (text) => {
        setHeld((h) =>
          h.text === text ? h : { ...h, text, behind: h.text === undefined ? h.behind : [...h.behind, h.text] },
        );
        onChangeText?.(text);
      },
      onFocus: (event) => {
        setFocused(true);
        onFocus?.(event);
      },
      onBlur: (event) => {
        setFocused(false);
        onBlur?.(event);
      },
    },
  };
}
