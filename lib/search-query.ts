/** How many characters a search needs, not counting a leading `@` or `#` (the lookups drop it). */
export const MIN_QUERY_LENGTH = 3

/** True when `query` has enough to search people and hashtags with. */
export function isSearchable(query: string): boolean {
  return query.trim().replace(/^[@#]/, '').length >= MIN_QUERY_LENGTH
}
