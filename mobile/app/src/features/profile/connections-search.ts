import type { UserSummaryDTO } from '@engine/api';

/** DashPay's rule, as web's list search: at least three characters before filtering (PRD PROF-04). */
const SEARCH_MIN = 3;

/** The query as the filter matches it: trimmed, without a leading `@`, lowercased. */
function searchNeedle(query: string): string {
  return query.trim().replace(/^@/, '').toLowerCase();
}

/** Whether the query is long enough to filter the list ({@link SEARCH_MIN} characters, not counting `@`). */
export function isSearching(query: string): boolean {
  return searchNeedle(query).length >= SEARCH_MIN;
}

/**
 * The rows whose username starts with the query (as a DPNS prefix search
 * does), or whose name contains it. `@` and case are ignored.
 */
export function filterUsers(users: readonly UserSummaryDTO[], query: string): UserSummaryDTO[] {
  const needle = searchNeedle(query);
  if (needle.length < SEARCH_MIN) return [...users];
  return users.filter(
    (user) =>
      (user.username ?? '').toLowerCase().startsWith(needle) || user.displayName.toLowerCase().includes(needle),
  );
}
