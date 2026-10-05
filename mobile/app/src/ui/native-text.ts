import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
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
 * reported (a reset, a cleared search, "Randomize", a message sent) is a
 * programmatic change, put in by mounting a fresh input with it as
 * `defaultValue` (it takes the focus the old one had, unless the field is
 * locked). A `value` the field has since typed past is a render from before
 * the latest keystrokes reached the caller, and changes nothing. So a caller
 * cannot refuse a keystroke by keeping its old `value` (no caller does):
 * limit the input with its own props (`maxLength`) instead.
 *
 * What the field reported is kept outside React state, updated as each
 * keystroke arrives, and compared once a render commits: a caller whose
 * value lives in a store (a DM draft) re-renders in another lane than this
 * hook's own state would, so state could lag its value and read a fresh
 * keystroke as a reset.
 */

/** What renders the input. */
interface Mount {
  /** The input's `defaultValue`; `generation` is its `key`, bumped to mount it afresh with a new text. */
  initial: string | undefined;
  generation: number;
  /** Whether the input it replaced had focus, so the new one takes it. */
  refocus: boolean;
  focused: boolean;
}

/** The native field's text as JS hears of it, and the input it renders. */
function createField(value: string | undefined) {
  let mount: Mount = { initial: value, generation: 0, refocus: false, focused: false };
  /** The text the native field holds. */
  let text = value;
  /** Texts the field held before `text` that the caller's `value` may still show. */
  let behind: string[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: Mount) => {
    mount = next;
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => mount,
    typed: (next: string) => {
      if (next === text) return;
      if (text !== undefined) behind.push(text);
      text = next;
    },
    focus: (focused: boolean) => {
      if (mount.focused !== focused) publish({ ...mount, focused });
    },
    /** The caller's `value` as a committed render shows it. */
    shown: (value: string | undefined, editable: boolean) => {
      if (value === undefined) return;
      if (value === text) {
        behind = [];
      } else if (!behind.includes(value)) {
        text = value;
        behind = [];
        // The input that had the focus is gone; the new one says so itself when it takes it.
        publish({ initial: value, generation: mount.generation + 1, refocus: mount.focused && editable, focused: false });
      }
    },
  };
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
  const [field] = useState(() => createField(value));
  const mount = useSyncExternalStore(field.subscribe, field.mount);
  const locked = editable === false;

  useLayoutEffect(() => {
    field.shown(value, !locked);
  }, [field, value, locked]);

  return {
    key: mount.generation,
    focused: mount.focused,
    inputProps: {
      defaultValue: mount.initial,
      autoFocus: mount.generation === 0 ? autoFocus : mount.refocus,
      onChangeText: (text) => {
        field.typed(text);
        onChangeText?.(text);
      },
      onFocus: (event) => {
        field.focus(true);
        onFocus?.(event);
      },
      onBlur: (event) => {
        field.focus(false);
        onBlur?.(event);
      },
    },
  };
}
