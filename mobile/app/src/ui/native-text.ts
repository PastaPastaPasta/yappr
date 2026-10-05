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
  /**
   * Set only just after `clear()`, while a change event the field sent before
   * it may still come in: the text the field must show (`sentEcho`).
   */
  value?: string;
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

/**
 * How long after `clear()` a change event may still be one the field sent
 * before it: a keystroke typed right after Send, reported with the sent text
 * still in front of it (QA rc9 c2).
 */
export const SENT_ECHO_MS = 1_500;

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
  /**
   * The text `clear()` took out, while a change event sent before the clear
   * may still arrive with it in front of the new keystrokes. One event that
   * does not start with it (the field was cleared), a programmatic value, or
   * `SENT_ECHO_MS` ends it.
   */
  let sent: { text: string; at: number } | null = null;
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
    /**
     * The field reported `next`; returns the text the caller hears. Just after
     * `clear()`, a report of the cleared text with keystrokes after it was sent
     * before the clear landed (or Android dropped the clear: its event count
     * was behind the keystroke): the keystrokes alone are the text, and the
     * field is held to them until it reports text of its own.
     */
    typed: (next: string): string => {
      const now = performance.now();
      if (sent && now - sent.at > SENT_ECHO_MS) sent = null;
      let heard = next;
      if (sent && next.length > sent.text.length && next.startsWith(sent.text)) {
        heard = next.slice(sent.text.length);
        publish({ ...mount, value: heard });
      } else if (sent || mount.value !== undefined) {
        sent = null;
        if (mount.value !== undefined) publish({ ...mount, value: undefined });
      }
      if (heard === text) return heard;
      dropExpired(now);
      if (text !== undefined) behind.push({ text, at: now });
      text = heard;
      return heard;
    },
    /** Empties the field now (a message sent), from the event that empties the caller's text. */
    clear: () => {
      sent = text ? { text, at: performance.now() } : null;
      text = '';
      behind = [];
      if (input?.clear) {
        input.clear();
        if (mount.value !== undefined) publish({ ...mount, value: undefined });
      } else {
        publish({ initial: '', generation: mount.generation + 1, refocus: mount.focused, focused: false });
      }
    },
    focus: (focused: boolean) => {
      if (mount.focused !== focused) publish({ ...mount, focused });
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
        sent = null;
        if (mount.value !== undefined) publish({ ...mount, value: undefined });
      } else {
        text = value;
        behind = [];
        // A text put back (a failed message) is the user's: nothing is taken off its front.
        sent = null;
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
  /**
   * Empties the field at once, from the handler that empties the caller's
   * text (Send), and takes a change event sent before it for the keystrokes
   * after the cleared text only.
   */
  clear: () => void;
  /**
   * Spread on the TextInput, in place of the caller's `value` (it holds a `value` of its own only
   * briefly after `clear()`). Its own `onChangeText`, `onFocus` and `onBlur` are these.
   */
  inputProps: Pick<TextInputProps, 'value' | 'defaultValue' | 'autoFocus' | 'onChangeText' | 'onFocus' | 'onBlur'>;
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
    clear: field.clear,
    focused: mount.focused,
    inputProps: {
      value: mount.value,
      defaultValue: mount.initial,
      autoFocus: mount.generation === 0 ? autoFocus : mount.refocus,
      onChangeText: (text) => {
        onChangeText?.(field.typed(text));
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
