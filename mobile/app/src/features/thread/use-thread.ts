import type { PostDTO, ThreadDTO } from '@engine/api/dto';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { engine } from '~/engine';
import { persistedQuery } from '~/state/query-client';

/** How long to wait before re-reading a thread whose post came back missing. */
export const NOT_FOUND_RECHECK_MS = 3000;

/**
 * A post's thread (`posts.thread`). Its pages are cumulative: each one holds
 * the whole thread loaded so far, re-nested, so the query keeps only the
 * latest page (`maxPages: 1`). A refresh re-reads that page through its own
 * cursor, so the replies already loaded stay loaded. Persisted, so a thread
 * opened before paints at once on the next launch.
 */
export function useThread(id: string) {
  const query = useInfiniteQuery<ThreadDTO, Error, InfiniteData<ThreadDTO>, readonly unknown[], string | null>({
    ...persistedQuery,
    queryKey: queryKeys.post.thread(id),
    queryFn: async ({ pageParam }) => {
      const thread = await engine.api.posts.thread(id, pageParam);
      if (thread.focus || pageParam !== null) return thread;
      // lib answers a failed single read as "absent" (on sakura, often a "Quorum not found in cache"
      // proof miss that clears in seconds): ask once more before saying "Post not found".
      await new Promise((resolve) => setTimeout(resolve, NOT_FOUND_RECHECK_MS));
      return engine.api.posts.thread(id, pageParam);
    },
    initialPageParam: null,
    getNextPageParam: (last) => (last.replies.hasMore && last.replies.cursor ? last.replies.cursor : undefined),
    maxPages: 1,
    enabled: id.length > 0,
  });
  const thread = query.data?.pages[query.data.pages.length - 1];
  return { ...query, thread };
}

/**
 * The card that opened the screen (`openPost` seeds it), for an instant
 * render; never fetched here, the thread brings the fresh copy.
 */
export function useSeedPost(id: string): PostDTO | null | undefined {
  const { data } = useEngineQuery(queryKeys.post.detail(id), (api) => api.posts.get(id), { enabled: false });
  return data;
}

/**
 * The focus's direct parent when the thread doesn't list it (flat threads
 * hold only the root above a reply): `undefined` while unknown, `null` when
 * nothing exists under the id.
 */
export function useParentPost(parentId: string | undefined) {
  const id = parentId ?? '';
  return useEngineQuery(queryKeys.post.detail(id), (api) => api.posts.get(id), {
    enabled: id.length > 0,
    persist: true,
  });
}
