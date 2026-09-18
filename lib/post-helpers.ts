/**
 * Helper functions for creating and managing posts on Dash Platform
 */

/**
 * Suffix used to distinguish cashtags from hashtags in storage
 * e.g., $DASH is stored as "dash_cashtag"
 * Uses underscore (not hyphen) to match contract pattern: ^[a-z0-9_]{1,63}$
 */
export const CASHTAG_SUFFIX = '_cashtag'

/**
 * Check if a stored tag is a cashtag (ends with _cashtag suffix)
 */
export function isCashtagStorage(tag: string): boolean {
  return tag.endsWith(CASHTAG_SUFFIX)
}

/**
 * Convert a stored cashtag format to display format
 * e.g., "dash_cashtag" -> "DASH"
 */
export function cashtagStorageToDisplay(tag: string): string {
  if (!isCashtagStorage(tag)) return tag
  return tag.slice(0, -CASHTAG_SUFFIX.length).toUpperCase()
}

/**
 * Convert a display cashtag to storage format
 * e.g., "DASH" or "$DASH" -> "dash_cashtag"
 * An optional ceiling includes the suffix, so indexed cashtags fit the contract.
 */
export function cashtagDisplayToStorage(tag: string, maxLength?: number): string {
  const normalized = tag.startsWith('$') ? tag.slice(1) : tag
  const symbol = maxLength === undefined
    ? normalized
    : normalized.slice(0, maxLength - CASHTAG_SUFFIX.length)
  return symbol.toLowerCase() + CASHTAG_SUFFIX
}

/**
 * Get the display text for a stored tag
 * e.g., "dash_cashtag" -> "$DASH", "dash" -> "#dash"
 */
export function getTagDisplayText(tag: string): string {
  if (isCashtagStorage(tag)) {
    return '$' + cashtagStorageToDisplay(tag)
  }
  return '#' + tag
}

/**
 * Extract hashtags from post content
 * Max 63 chars to match Dash Platform indexed property constraint
 */
export function extractHashtags(content: string): string[] {
  const regex = /#[a-zA-Z0-9_]{1,63}/g
  const matches = content.match(regex) || []
  return Array.from(new Set(matches.map(tag => tag.slice(1).toLowerCase()))) // Remove # prefix, lowercase, dedupe
}

/**
 * The FIRST hashtag in the content, in `post.hashtag` storage form: lowercase,
 * no `#`, and `''` when the content carries no (valid) hashtag. The
 * single-hashtag model indexes exactly one tag per post, and "first in the
 * text" is the rule the client applies.
 *
 * `maxLength` is the contract's pattern ceiling (`HASHTAG_MAX_LENGTH` in
 * lib/contract-topology). A longer tag is truncated to the ceiling. How `''`
 * is spelled on-chain is the CALLER's concern: on the inline-hashtag topology
 * the property is simply omitted.
 */
export function firstHashtag(content: string, maxLength: number = 63): string {
  const match = content.match(new RegExp(`#([a-zA-Z0-9_]{1,${maxLength}})`))
  return match ? match[1].toLowerCase() : ''
}

/**
 * The single inline tag: preserve the first hashtag's precedence, then fall
 * back to the first cashtag when there is no hashtag in the public content.
 */
export function firstIndexedTag(content: string, maxLength: number = 63): string {
  const hashtag = firstHashtag(content, maxLength)
  if (hashtag) return hashtag
  const cashtag = content.match(/\$([a-zA-Z][a-zA-Z0-9_]{0,62})/)
  return cashtag ? cashtagDisplayToStorage(cashtag[1], maxLength) : ''
}

/**
 * Extract cashtags from post content (e.g., $DASH, $BTC)
 * Returns tags in storage format (e.g., "dash_cashtag")
 */
export function extractCashtags(content: string): string[] {
  const regex = /\$[a-zA-Z][a-zA-Z0-9_]{0,62}/g
  const matches = content.match(regex) || []
  return Array.from(new Set(
    matches.map(tag => tag.slice(1).toLowerCase() + CASHTAG_SUFFIX)
  )) // Remove $ prefix, lowercase, add suffix, dedupe
}

/**
 * Extract all tags (hashtags and cashtags) from post content
 * Returns tags in storage format ready for the hashtag service
 */
export function extractAllTags(content: string): string[] {
  const hashtags = extractHashtags(content)
  const cashtags = extractCashtags(content)
  return Array.from(new Set([...hashtags, ...cashtags]))
}

/**
 * Normalize a DPNS username by removing .dash suffix
 * e.g., "pasta.dash" -> "pasta", "Pasta" -> "pasta"
 */
export function normalizeDpnsUsername(username: string): string {
  return username.toLowerCase().replace(/\.dash$/i, '')
}

/**
 * Extract @mentions from post content
 * Returns usernames without the @ prefix, normalized (lowercase, .dash removed), and deduplicated
 * Handles both @pasta and @pasta.dash formats
 * Max 100 chars to accommodate DPNS username constraints
 */
export function extractMentions(content: string): string[] {
  // DPNS labels can contain hyphens, including usernames selected by autocomplete.
  const regex = /@([a-zA-Z0-9_-]{1,100}(?:\.dash)?)/gi
  const matches = content.match(regex) || []
  return Array.from(new Set(
    matches.map(mention => normalizeDpnsUsername(mention.slice(1))) // Remove @ prefix, normalize, dedupe
  ))
}
