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
 * programmatic change: an empty one clears the input in place
 * (`TextInput.clear()`), any other is put in by mounting a fresh input with
 * it as `defaultValue` (it takes the focus the old one had, unless the field
 * is locked). A `value` the field has since typed past is a render from before
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

/** The mounted input, as far as this needs it: `TextInput.clear()` (a wrapper may not pass it on). */
export interface ClearableInput {
  clear?: () => void;
}

/**
 * How long a render from before a keystroke may take to commit: past this,
 * the JS thread stalled longer than any lag seen, and the history kept to
 * recognise such renders is dropped.
 */
export const RENDER_LAG_MS = 10_000;

/** The native field's text as JS hears of it, and the input it renders. */
function createField(value: string | undefined) {
  let mount: Mount = { initial: value, generation: 0, refocus: false, focused: false };
  let input: ClearableInput | null = null;
  /** The text the native field holds. */
  let text = value;
  /**
   * Texts the field held before `text`, oldest first (with when each was
   * typed past), that the caller's `value` may still show. Its renders come
   * in the order of the keystrokes, so a render showing a text consumes the
   * history up to the first entry with it, and no further: the same text may
   * come again later ("a", "ab", "a", "ac"). React may batch keystrokes into
   * one render, so an entry can be skipped by every render. It goes once a
   * render shows the field's own text and no entry has it (caught up), or
   * once it is older than `RENDER_LAG_MS`: until then a programmatic set to
   * exactly that text right after typing it is taken for a late render.
   */
  let behind: { text: string; at: number }[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: Mount) => {
    mount = next;
    listeners.forEach((listener) => listener());
  };
  const dropExpired = (now: number) => {
    const live = behind.findIndex((entry) => now - entry.at < RENDER_LAG_MS);
    behind = live < 0 ? [] : behind.slice(live);
  };
  /** The first unconsumed entry with `shown`, or -1. */
  const pending = (shown: string) => behind.findIndex((entry) => entry.text === shown);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => mount,
    attach: (next: ClearableInput | null | undefined) => {
      input = next ?? null;
    },
    typed: (next: string) => {
      if (next === text) return;
      const now = Date.now();
      dropExpired(now);
      if (text !== undefined) behind.push({ text, at: now });
      text = next;
    },
    focus: (focused: boolean) => {
      if (mount.focused !== focused) publish({ ...mount, focused });
    },
    /** The caller's `value` as a committed render shows it. */
    shown: (value: string | undefined, editable: boolean) => {
      if (value === undefined) return;
      dropExpired(Date.now());
      const index = pending(value);
      if (index >= 0) {
        // A render from before the latest keystrokes (or, the same text typed again, the latest).
        behind = behind.slice(index + 1);
      } else if (value === text) {
        // Caught up.
        behind = [];
      } else if (value === '' && input?.clear) {
        // Emptied (a message sent, a search cleared): in place, so the input keeps its focus and
        // keyboard, and the caller hears no blur and focus.
        input.clear();
        text = '';
        behind = [];
      } else {
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
  /** Pass as the TextInput's `ref`, so an emptied value clears it in place. */
  attach: (input: ClearableInput | null | undefined) => void;
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
    attach: field.attach,
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
