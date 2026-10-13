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
 * Convert a display hashtag to storage format
 * e.g., "#Dash" -> "dash"
 * An optional ceiling truncates it the way `indexedTags` does, so a link to
 * an over-long tag opens the page it was indexed under.
 */
export function hashtagDisplayToStorage(tag: string, maxLength?: number): string {
  const normalized = (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase()
  return maxLength === undefined ? normalized : normalized.slice(0, maxLength)
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
 * The tags a post is indexed under, in storage form: the content's hashtags
 * in order, then its cashtags, distinct, at most `max` of them, each at most
 * `maxLength` characters (a longer one is truncated to its first `maxLength`). With `max` 1 that is the first hashtag, or the first cashtag when
 * there is none: the one-tag cuts' rule. `[]` when the content names no tag.
 *
 * `maxLength` is the contract's pattern ceiling (`HASHTAG_MAX_LENGTH` in
 * lib/contract-topology, 61: the ranked key-size limit). It is required so no
 * caller can build a tag longer than consensus accepts. How `[]` is spelled
 * on-chain is the CALLER's concern: the write paths omit the property.
 */
export function indexedTags(content: string, max: number, maxLength: number): string[] {
  const tags: string[] = []
  const add = (tag: string) => {
    if (tag !== '' && tags.length < max && !tags.includes(tag)) tags.push(tag)
  }
  for (const match of Array.from(content.matchAll(new RegExp(`#([a-zA-Z0-9_]{1,${maxLength}})`, 'g')))) {
    add(match[1].toLowerCase())
  }
  for (const match of Array.from(content.matchAll(/\$([a-zA-Z][a-zA-Z0-9_]{0,62})/g))) {
    add(cashtagDisplayToStorage(match[1], maxLength))
  }
  return tags
}

/**
 * A stored post's (or removal record's) tags, read back off either spelling:
 * `[hashtag]` (one tag, through social v15) or the `tags` list (v16), `[]`
 * when the document carries none. Undefined for a value that is neither, so a
 * caller can tell "untagged" from "unreadable".
 */
export function storedTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value) && value.every((tag) => typeof tag === 'string')) return [...value]
  return undefined
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
 * Returns usernames without the @ prefix, normalized (lowercase, .dash removed), and deduplicated,
 * in order of first appearance (the order inline mentions are indexed in)
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
