import { truncateId } from '~/lib-allowlist';

/** "@alice", or the truncated identity id for an author with no DPNS name (UX_SPEC §2.4.3). */
export function handleOf({ id, username }: { id: string; username: string | null }): string {
  return username ? `@${username}` : truncateId(id);
}
