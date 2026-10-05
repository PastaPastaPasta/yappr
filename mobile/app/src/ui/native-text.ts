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
 * `clear()` (Send) mounts a fresh input instead of clearing the old one. A
 * change event the old field sent before a clear landed, or after Android
 * dropped it (a clear carries the event count JS last saw, and Android
 * ignores one behind the field's own), reports the sent text with whatever
 * was typed after it. Nothing in the event tells it from text typed or
 * pasted after the clear: a JS-set text sends no event and does not move the
 * count, on Android or iOS. A fresh field cannot get the old one's
 * keystrokes, and events from the old one are ignored: a keystroke typed in
 * the instant after Send can be lost, but the sent text is never sent again,
 * and nothing typed or pasted afterwards is cut.
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
   * once it is older than `RENDER_LAG_MS` (on the monotonic clock, so a
 * clock change cannot drop it early): until then a programmatic set to
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
    /** The field of mount `generation` reported `next`; false when that input has since been replaced. */
    typed: (next: string, generation: number): boolean => {
      if (generation !== mount.generation) return false;
      if (next === text) return true;
      const now = performance.now();
      dropExpired(now);
      if (text !== undefined) behind.push({ text, at: now });
      text = next;
      return true;
    },
    /**
     * Sets the field's text now, for an action of the user's (Clear, a recent
     * search, Randomize): never mistaken for a late render of typing. Empty
     * clears it in place, keeping the focus and keyboard.
     */
    reset: (next: string) => {
      text = next;
      behind = [];
      if (next === '' && input?.clear) input.clear();
      else publish({ initial: next, generation: mount.generation + 1, refocus: mount.focused, focused: false });
    },
    /** Empties the field now (a message sent): a fresh input, which takes the focus the old one had. */
    clear: () => {
      text = '';
      behind = [];
      publish({ initial: '', generation: mount.generation + 1, refocus: mount.focused, focused: false });
    },
    focus: (focused: boolean, generation: number) => {
      if (generation === mount.generation && mount.focused !== focused) publish({ ...mount, focused });
    },
    /** The caller's `value` as a committed render shows it. */
    shown: (value: string | undefined, editable: boolean) => {
      if (value === undefined) return;
      dropExpired(performance.now());
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

/** What a field that owns its text lets its parent do: set the text for an action of the user's. */
export interface TextResetHandle {
  reset: (value: string) => void;
}

export interface NativeText {
  /** The TextInput's `key`. */
  key: number;
  /** Pass as the TextInput's `ref`, so an emptied value clears it in place. */
  attach: (input: ClearableInput | null | undefined) => void;
  /**
   * Empties the field at once with a fresh input, from the handler that
   * empties the caller's text (Send): the old input's late events are ignored.
   */
  clear: () => void;
  /**
   * Sets the text for an action of the user's (Clear, a recent search,
   * Randomize), then the caller updates its own value to it: a `value`
   * change alone can be taken for a late render of typing.
   */
  reset: (value: string) => void;
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

  const { generation } = mount;
  return {
    key: generation,
    attach: field.attach,
    clear: field.clear,
    reset: field.reset,
    focused: mount.focused,
    inputProps: {
      defaultValue: mount.initial,
      autoFocus: generation === 0 ? autoFocus : mount.refocus,
      // Each input's handlers name its own mount: a replaced input's late events change nothing.
      onChangeText: (text) => {
        if (field.typed(text, generation)) onChangeText?.(text);
      },
      onFocus: (event) => {
        field.focus(true, generation);
        onFocus?.(event);
      },
      onBlur: (event) => {
        field.focus(false, generation);
        onBlur?.(event);
      },
    },
  };
}
