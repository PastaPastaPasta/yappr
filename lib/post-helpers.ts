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
 */
export function cashtagDisplayToStorage(tag: string): string {
  const normalized = tag.startsWith('$') ? tag.slice(1) : tag
  return normalized.toLowerCase() + CASHTAG_SUFFIX
}

/**
 * Get the display symbol for a tag (# or $)
 */
export function getTagSymbol(tag: string): string {
  return isCashtagStorage(tag) ? '$' : '#'
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
  // Match @username or @username.dash format (no hyphens - DPNS doesn't allow them)
  const regex = /@([a-zA-Z0-9_]{1,100}(?:\.dash)?)/gi
  const matches = content.match(regex) || []
  return Array.from(new Set(
    matches.map(mention => normalizeDpnsUsername(mention.slice(1))) // Remove @ prefix, normalize, dedupe
  ))
}
