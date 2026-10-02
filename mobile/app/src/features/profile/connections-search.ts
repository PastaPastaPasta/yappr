import type { UserSummaryDTO } from '@engine/api';

/** DashPay's rule, as web's list search: at least three characters before filtering (PRD PROF-04). */
export const SEARCH_MIN = 3;

/**
 * The rows whose username starts with the query (as a DPNS prefix search
 * does), or whose name contains it. `@` and case are ignored.
 */
export function filterUsers(users: readonly UserSummaryDTO[], query: string): UserSummaryDTO[] {
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  if (needle.length < SEARCH_MIN) return [...users];
  return users.filter(
    (user) =>
      (user.username ?? '').toLowerCase().startsWith(needle) || user.displayName.toLowerCase().includes(needle),
  );
}
