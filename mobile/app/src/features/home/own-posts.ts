import type { PostDTO } from '@engine/api';
import { useQueries } from '@tanstack/react-query';
import { create } from 'zustand';

import { queryKeys } from '~/data/keys';
import { engineQueryOptions } from '~/data/queries';

/**
 * The viewer's own new posts, kept on top of For You until the feed itself
 * returns them (PRD PD-3). The data layer seeds each one's detail on
 * `content.created` and refetches the feeds; a post the network has not
 * indexed yet would drop out of that refetch, so it stays pinned here. The
 * post renders from its detail query, so likes and deletes reach it too.
 */

/** A pin the feed never confirms (a failed write, a filter) goes after this. */
const PIN_MS = 10 * 60_000;
const MAX_PINS = 10;

export const useOwnPosts = create<{ ids: string[] }>()(() => ({ ids: [] }));

/** Each pin's expiry, cleared with the pin. */
const expiries = new Map<string, ReturnType<typeof setTimeout>>();

export function unpinOwnPosts(ids: readonly string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) {
    clearTimeout(expiries.get(id));
    expiries.delete(id);
  }
  const drop = new Set(ids);
  useOwnPosts.setState(({ ids: pinned }) => ({ ids: pinned.filter((id) => !drop.has(id)) }));
}

export function pinOwnPost(id: string): void {
  const { ids } = useOwnPosts.getState();
  const next = [id, ...ids.filter((pinned) => pinned !== id)];
  // Past the cap, the oldest pins go (with their timers).
  unpinOwnPosts(next.slice(MAX_PINS));
  useOwnPosts.setState({ ids: next.slice(0, MAX_PINS) });
  clearTimeout(expiries.get(id));
  expiries.set(
    id,
    setTimeout(() => unpinOwnPosts([id]), PIN_MS),
  );
}

/** Drop every pin and its timer (tests). */
export function resetOwnPosts(): void {
  unpinOwnPosts([...expiries.keys()]);
  useOwnPosts.setState({ ids: [] });
}

const cachedPosts = (results: { data?: PostDTO | null }[]): PostDTO[] =>
  results.flatMap((result) => (result.data ? [result.data] : []));

/** The pinned posts still in the cache (newest first). An account switch clears the cache, and with it the pins' posts. */
export function usePinnedPosts(): PostDTO[] {
  const ids = useOwnPosts((s) => s.ids);
  return useQueries({
    queries: ids.map((id) =>
      // Cache-only: the seed from `content.created`, patched by optimistic updates.
      engineQueryOptions(queryKeys.post.detail(id), (api) => api.posts.get(id), { enabled: false }),
    ),
    combine: cachedPosts,
  });
}
