import type { TextStyle } from 'react-native';

/**
 * Per-paragraph text direction for user content (PRD G-9, A11Y-07): each
 * paragraph takes the direction of its first strong character, so Arabic and
 * Hebrew paragraphs align right while the app chrome stays left to right.
 *
 * React Native can't do this inside one <Text>: Android aligns the whole
 * text by its first strong character (RN's TextLayoutManager), and iOS
 * resolves `textAlign: 'auto'` against the app's LTR layout. So callers
 * render one <Text> per run of same-direction paragraphs, styled with
 * `directionStyle`.
 */

export type Direction = 'ltr' | 'rtl';

const LETTER = /\p{L}/u;

/** Blocks whose letters are right to left (Bidi_Class R or AL). */
function isRtlLetter(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) || // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic supplements
    (cp >= 0xfb1d && cp <= 0xfdff) || // Hebrew and Arabic presentation forms A
    (cp >= 0xfe70 && cp <= 0xfeff) || // Arabic presentation forms B
    (cp >= 0x10800 && cp <= 0x10fff) || // historic RTL scripts, Hanifi Rohingya, Yezidi
    (cp >= 0x1e800 && cp <= 0x1efff) // Mende Kikakui, Adlam, Arabic mathematical letters
  );
}

/**
 * The direction of the first strong character, or null when there is none.
 * Letters are strong; digits, punctuation, spaces, marks and emoji are not,
 * so "2024 مرحبا" and "🎉 שלום" are right to left. The directional marks
 * (LRM, RLM, ALM) count too.
 */
export function firstStrongDirection(text: string): Direction | null {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0x200e) return 'ltr';
    if (cp === 0x200f || cp === 0x061c) return 'rtl';
    if (LETTER.test(char)) return isRtlLetter(cp) ? 'rtl' : 'ltr';
  }
  return null;
}

const isBlank = (line: string) => line.trim() === '';

/**
 * Each line's direction. A line with a strong character takes its own. A
 * line without one ("2024", "🎉") follows the line before it, or the first
 * strong line when it leads. A blank line belongs to the paragraph after it,
 * so a blank line between two directions starts the next run. Null only
 * when no line has a strong character.
 */
export function lineDirections(lines: readonly string[]): (Direction | null)[] {
  const own = lines.map(firstStrongDirection);
  let last = own.find((d) => d !== null) ?? null;
  const resolved = own.map((d) => {
    if (d !== null) last = d;
    return last;
  });
  let next: Direction | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!isBlank(line)) next = resolved[i] ?? null;
    else if (next !== null) resolved[i] = next;
  }
  return resolved;
}

export interface DirectionRun {
  direction: Direction | null;
  /** The run's first line index. */
  start: number;
  /** One past its last line index. */
  end: number;
}

/** Consecutive lines of one direction, in order. Every line is in exactly one run. */
export function directionRuns(lines: readonly string[]): DirectionRun[] {
  const runs: DirectionRun[] = [];
  lineDirections(lines).forEach((direction, i) => {
    const run = runs[runs.length - 1];
    if (run && run.direction === direction) run.end = i + 1;
    else runs.push({ direction, start: i, end: i + 1 });
  });
  return runs;
}

/** Plain text in same-direction blocks; the blocks joined by '\n' are the text. */
export function directionBlocks(text: string): { direction: Direction | null; text: string }[] {
  const lines = text.split('\n');
  return directionRuns(lines).map(({ direction, start, end }) => ({
    direction,
    text: lines.slice(start, end).join('\n'),
  }));
}

/**
 * Each block's `numberOfLines`, so the blocks together show at most
 * `maxLines`: a block gets what the blocks above it left (0: not shown). The
 * blocks after one not laid out yet wait at 0, so the text only grows as the
 * layouts come in and never shows more than `maxLines` lines. A layout's
 * lines are counted up to the block's cap, whether or not the platform
 * reports the hidden ones.
 */
export function blockLineCaps(
  measured: readonly (number | undefined)[],
  blocks: number,
  maxLines: number | undefined,
): (number | undefined)[] {
  if (maxLines === undefined) return Array.from({ length: blocks }, () => undefined);
  let remaining = maxLines;
  return Array.from({ length: blocks }, (_, i) => {
    const cap = Math.max(remaining, 0);
    const lines = measured[i];
    remaining = lines === undefined ? 0 : remaining - Math.min(lines, cap);
    return cap;
  });
}

const RTL: TextStyle = { writingDirection: 'rtl', textAlign: 'right' };
const LTR: TextStyle = { writingDirection: 'ltr', textAlign: 'left' };
const AUTO: TextStyle = { writingDirection: 'auto' };

/** A block's <Text> style: right-aligned RTL, left-aligned LTR, natural when it has no strong character. */
export function directionStyle(direction: Direction | null): TextStyle {
  if (direction === 'rtl') return RTL;
  if (direction === 'ltr') return LTR;
  return AUTO;
}
