/**
 * Post length rules, mirroring `lib/compose/limits.ts` exactly (PRD COMP-02)
 * without importing it: that module reads the contract topology from the
 * web's build env. The limits themselves come from the engine
 * (`capabilities.contentLimits`); `limits.test.ts` pins these functions
 * against lib's on shared fixtures.
 */

export interface ContentLimits {
  /** Code points. */
  chars: number;
  /** UTF-8 bytes, or null where the contract declares no byte ceiling. */
  bytes: number | null;
}

/** Before the engine has ever booted: the smallest limits any contract has (v2). */
export const FALLBACK_LIMITS: ContentLimits = { chars: 500, bytes: null };

/** Characters as the contract's `maxLength` counts them: Unicode code points. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** The UTF-8 length of one code point. */
function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Bytes as the contract's `maxBytes` counts them: the UTF-8 encoding. A lone
 * surrogate encodes as U+FFFD (3 bytes), as `TextEncoder` does.
 */
export function utf8ByteCount(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += codePointBytes(ch.codePointAt(0) ?? 0xfffd);
  return bytes;
}

/** How far `text` is over each limit; zero means within it. */
export function contentOverage(text: string, limits: ContentLimits): { charactersOver: number; bytesOver: number } {
  const charactersOver = Math.max(0, characterCount(text) - limits.chars);
  const bytesOver = limits.bytes === null ? 0 : Math.max(0, utf8ByteCount(text) - limits.bytes);
  return { charactersOver, bytesOver };
}

export function isOverContentLimit(text: string, limits: ContentLimits): boolean {
  const { charactersOver, bytesOver } = contentOverage(text, limits);
  return charactersOver > 0 || bytesOver > 0;
}

/**
 * True when the text has something a reader can see: whitespace and
 * default-ignorable code points (zero-width space and joiners, word joiner,
 * BOM, soft hyphen, variation selectors) alone render as an empty post.
 */
export function hasVisibleContent(text: string): boolean {
  return text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '').length > 0;
}

/**
 * The UTF-16 offset of the first code point past a limit, or null when the
 * text fits: where the editor starts the red overflow highlight (PRD
 * COMP-02). Whichever limit binds first wins.
 */
export function overflowOffset(text: string, limits: ContentLimits): number | null {
  let chars = 0;
  let bytes = 0;
  let offset = 0;
  for (const ch of text) {
    chars += 1;
    bytes += codePointBytes(ch.codePointAt(0) ?? 0xfffd);
    if (chars > limits.chars || (limits.bytes !== null && bytes > limits.bytes)) return offset;
    offset += ch.length;
  }
  return null;
}

export type CounterTone = 'secondary' | 'warning' | 'error';

/** The counter's color: gray, amber at 50 or fewer characters left, red when over either limit. */
export function counterTone(text: string, limits: ContentLimits): CounterTone {
  const { charactersOver, bytesOver } = contentOverage(text, limits);
  if (charactersOver > 0 || bytesOver > 0) return 'error';
  return limits.chars - characterCount(text) <= 50 ? 'warning' : 'secondary';
}

/** "{current} of {limit} characters", plus ", {N} over limit" (UX_SPEC §5.4). */
export function counterLabel(text: string, limits: ContentLimits): string {
  const current = characterCount(text);
  const over = current - limits.chars;
  return `${current} of ${limits.chars} characters${over > 0 ? `, ${over} over limit` : ''}`;
}
