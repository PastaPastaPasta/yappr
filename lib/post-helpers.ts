/**
 * Helper functions for creating and managing posts on Dash Platform
 */

/**
 * Suffix used to distinguish cashtags from hashtags in storage
 * e.g., $DASH is stored as "dash_cashtag"
 * Uses underscore (not hyphen) to match the contract's `^[a-z0-9_]{1,N}$` tag pattern
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
 * Convert a display hashtag to storage format
 * e.g., "#Dash" -> "dash"
 */
export function hashtagDisplayToStorage(tag: string): string {
  return (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase()
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

/** A link in post text: `http(s)://`, `ipfs://` or `www.`. The post renderer (`components/post/post-content.tsx`) links what it matches. */
export const URL_PATTERN = /(https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g

/**
 * What may not follow a tag: a letter, digit or combining mark in any
 * script, or `_`. The contract stores ASCII tags only, so a tag is a whole
 * ASCII word: `#café`, `#naïve`, `#straße` or `#cafe` with a combining
 * accent is no tag at all (plain text), never the ASCII part before the
 * first other letter. Punctuation, emoji and spaces end a tag (`#ok!`,
 * `#ok🙂`, `(#ok)`).
 */
const TAG_END = String.raw`(?![\p{L}\p{N}\p{M}_])`

/**
 * A hashtag in post text: `#` and a whole word of ASCII letters, digits and
 * `_` (group 1), of any length; {@link tagStorage} applies the contract's
 * ceiling. Global: clone it (`new RegExp(source, flags)`; `matchAll` keeps its
 * `lastIndex`) rather than share its state.
 */
export const HASHTAG_PATTERN = new RegExp(String.raw`#([a-zA-Z0-9_]+)` + TAG_END, 'gu')

/** A cashtag in post text: `$`, an ASCII letter, then a whole word as in {@link HASHTAG_PATTERN} (group 1 is the symbol). */
export const CASHTAG_PATTERN = new RegExp(String.raw`\$([a-zA-Z][a-zA-Z0-9_]*)` + TAG_END, 'gu')

/**
 * The storage form of a {@link HASHTAG_PATTERN} or {@link CASHTAG_PATTERN}
 * match (`#Dash` -> `dash`, `$DASH` -> `dash_cashtag`), or null when that
 * form is longer than `maxLength`, the contract's ceiling. An over-long tag
 * is no tag: plain text, neither linked nor indexed (never under a prefix of
 * itself).
 */
export function tagStorage(match: string, maxLength: number): string | null {
  const storage = match.startsWith('$') ? cashtagDisplayToStorage(match) : hashtagDisplayToStorage(match)
  return storage.length <= maxLength ? storage : null
}

type TagKind = 'hashtag' | 'cashtag'

/**
 * The distinct tags of `kind` the post renders as tags, in order, in storage
 * form. Links, hashtags and cashtags are matched in one pass, as the renderer
 * matches them; a match overlapping an earlier one is dropped (a link's
 * fragment or query, `…/#install`, `?q=$BTC`, is part of the link), and so is
 * a tag longer than `maxLength` ({@link tagStorage}). Each pattern is cloned,
 * so no caller's `lastIndex` leaks in.
 */
function renderedTags(content: string, kind: TagKind, maxLength: number): string[] {
  const patterns = [['url', URL_PATTERN], ['hashtag', HASHTAG_PATTERN], ['cashtag', CASHTAG_PATTERN]] as const
  const found: Array<{ kind: TagKind | 'url'; start: number; end: number; text: string }> = []
  for (const [matchKind, regex] of patterns) {
    for (const match of Array.from(content.matchAll(new RegExp(regex.source, regex.flags)))) {
      const start = match.index ?? 0
      found.push({ kind: matchKind, start, end: start + match[0].length, text: match[0] })
    }
  }
  found.sort((a, b) => a.start - b.start)
  const kept = new Set<string>()
  let lastEnd = 0
  for (const match of found) {
    if (match.start < lastEnd) continue
    lastEnd = match.end
    const tag = match.kind === kind ? tagStorage(match.text, maxLength) : null
    if (tag !== null) kept.add(tag)
  }
  return Array.from(kept)
}

/**
 * Extract hashtags from post content (none inside a link), lowercased and
 * deduplicated, each at most `maxLength` characters (a longer one is no tag)
 */
export function extractHashtags(content: string, maxLength: number): string[] {
  return renderedTags(content, 'hashtag', maxLength)
}

/**
 * Extract cashtags from post content (e.g., $DASH, $BTC; none inside a link)
 * Returns tags in storage format (e.g., "dash_cashtag"), each at most
 * `maxLength` characters with the suffix (a longer one is no tag)
 */
export function extractCashtags(content: string, maxLength: number): string[] {
  return renderedTags(content, 'cashtag', maxLength)
}

/**
 * The tags a post is indexed under, in storage form: the content's hashtags
 * in order, then its cashtags, distinct, at most `max` of them. A tag whose
 * storage form (`_cashtag` included) is longer than `maxLength` is no tag,
 * and neither is one inside a link, as the post renders it. With `max` 1
 * that is the first hashtag, or the first cashtag when there is none: the
 * one-tag cuts' rule. `[]` when the content names no tag.
 *
 * `maxLength` is the contract's pattern ceiling (`HASHTAG_MAX_LENGTH` in
 * lib/contract-topology, 61: the ranked key-size limit; v2's postHashtag
 * takes 63). It is required so no caller can build a tag longer than
 * consensus accepts. How `[]` is spelled on-chain is the CALLER's concern:
 * the write paths omit the property.
 */
export function indexedTags(content: string, max: number, maxLength: number): string[] {
  const tags = new Set([...extractHashtags(content, maxLength), ...extractCashtags(content, maxLength)])
  return Array.from(tags).slice(0, max)
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
 * Extract all tags (hashtags and cashtags) from post content
 * Returns tags in storage format ready for the hashtag service
 */
export function extractAllTags(content: string, maxLength: number): string[] {
  return indexedTags(content, Number.MAX_SAFE_INTEGER, maxLength)
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
