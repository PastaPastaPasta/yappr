/** Characters allowed in one post's content field. */
export const CHARACTER_LIMIT = 500

/**
 * Characters as the contract's `maxLength` counts them. Platform validates
 * documents with JSON Schema, which counts Unicode code points, so an emoji is
 * one character here even though it is two UTF-16 units in `String.length`.
 */
export function characterCount(text: string): number {
  return Array.from(text).length
}

/**
 * True when the text has something a reader can see: whitespace and
 * default-ignorable code points (zero-width space/joiners, word joiner, BOM,
 * soft hyphen, variation selectors) alone render as an empty post.
 */
export function hasVisibleContent(text: string): boolean {
  return text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '').length > 0
}
