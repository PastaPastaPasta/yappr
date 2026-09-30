import { contentLimits } from '@/lib/contract-topology'

/** Characters allowed in one post's content field (500; 1000 on v10). */
export const CHARACTER_LIMIT = contentLimits().maxLength

/**
 * UTF-8 bytes allowed in one post's content field, or null where the contract
 * declares no byte ceiling (v2, v9). v10's 2000 bytes binds before the 1000
 * characters once the text averages more than two bytes a character (most
 * emoji, CJK), so both limits are checked.
 */
export const BYTE_LIMIT = contentLimits().maxBytes

/**
 * Characters as the contract's `maxLength` counts them. Platform validates
 * documents with JSON Schema, which counts Unicode code points, so an emoji is
 * one character here even though it is two UTF-16 units in `String.length`.
 */
export function characterCount(text: string): number {
  return Array.from(text).length
}

/** Bytes as the contract's `maxBytes` counts them: the UTF-8 encoding. */
export function utf8ByteCount(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * How far `text` is over each content limit, with `extraAscii` characters
 * appended (an image URL folded into an encrypted post; ASCII, so one byte
 * each). Zero means within the limit; `bytesOver` is always zero where the
 * contract declares no byte ceiling.
 */
export function contentOverage(
  text: string,
  extraAscii = 0,
  limits: { maxLength: number; maxBytes: number | null } = { maxLength: CHARACTER_LIMIT, maxBytes: BYTE_LIMIT }
): { charactersOver: number; bytesOver: number } {
  const charactersOver = Math.max(0, characterCount(text) + extraAscii - limits.maxLength)
  const bytesOver = limits.maxBytes === null ? 0 : Math.max(0, utf8ByteCount(text) + extraAscii - limits.maxBytes)
  return { charactersOver, bytesOver }
}

/** True when `text` (plus `extraAscii` appended characters) breaks either content limit. */
export function isOverContentLimit(text: string, extraAscii = 0): boolean {
  const { charactersOver, bytesOver } = contentOverage(text, extraAscii)
  return charactersOver > 0 || bytesOver > 0
}

/**
 * True when the text has something a reader can see: whitespace and
 * default-ignorable code points (zero-width space/joiners, word joiner, BOM,
 * soft hyphen, variation selectors) alone render as an empty post.
 */
export function hasVisibleContent(text: string): boolean {
  return text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '').length > 0
}
