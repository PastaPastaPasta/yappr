import { textBytes } from '@/lib/text-limits'
import { HASHTAG_MAX_LENGTH, contentLimits, inlineMentions, inlineTags } from '@/lib/contract-topology'
import { extractMentions, indexedTags } from '@/lib/post-helpers'

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
  return textBytes(text)
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

/**
 * What the composer says when `text` @mentions more people than a post or
 * reply notifies, or null. On v15 a post indexes its first eight @mentions
 * ({@link inlineMentions}) and the rest stay plain text. v10–v14 index one
 * and say nothing about it, as before; v2/v9 index every mention.
 */
export function mentionLimitHint(text: string): string | null {
  const mentions = inlineMentions()
  if (!mentions?.isArray || extractMentions(text).length <= mentions.max) return null
  return `Only the first ${mentions.max} people you mention will be notified.`
}

/**
 * The mention hints of a thread's first post: under its body, or under its
 * teaser box. An encrypted post (private, or a reply inheriting encryption)
 * indexes the mentions of its public teaser only, and none without one
 * (`createPost`, `createReply`), so its body never gets a hint.
 */
export function firstPostMentionHints({ body, encrypted, teaser }: { body: string; encrypted: boolean; teaser?: string }): { body: string | null; teaser: string | null } {
  if (!encrypted) return { body: mentionLimitHint(body), teaser: null }
  return { body: null, teaser: teaser ? mentionLimitHint(teaser) : null }
}

/**
 * Why `text` cannot be a v16 post, or null: it names more distinct tags (the
 * hashtags and cashtags, {@link indexedTags}) than a post holds. The
 * contract's `post.tags` takes at most four, and a post names no tag it is
 * not indexed under, so the composer refuses a fifth rather than leaving it
 * plain text. Null before v16 (v9–v15 index one tag and leave the rest
 * plain text, as before; v2 indexes every tag).
 */
export function tagLimitProblem(text: string): string | null {
  const tags = inlineTags()
  if (!tags?.isArray) return null
  const named = indexedTags(text, Number.MAX_SAFE_INTEGER, HASHTAG_MAX_LENGTH).length
  if (named <= tags.max) return null
  const over = named - tags.max
  return `A post can have at most ${tags.max} tags. Remove ${over} ${over === 1 ? 'tag' : 'tags'}.`
}
