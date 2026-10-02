import type { PostDTO, ThreadDTO } from '@engine/api/dto';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { engine } from '~/engine';
import { persistedQuery, queryClient } from '~/state/query-client';

/** How long to wait before re-reading a thread whose post came back missing. */
export const NOT_FOUND_RECHECK_MS = 3000;

/** Whether this device already holds the thread with its focused post. */
function hasLoadedFocus(id: string): boolean {
  const pages = queryClient.getQueryData<InfiniteData<ThreadDTO>>(queryKeys.post.thread(id))?.pages;
  return Boolean(pages?.[pages.length - 1]?.focus);
}

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
      const read = () => engine.api.posts.thread(id, pageParam);
      const first = await read();
      if (first.focus) return first;
      // lib answers a failed single read as "absent" (on sakura, often a proof miss that clears in
      // seconds): ask once more before saying the post is gone.
      await new Promise((resolve) => setTimeout(resolve, NOT_FOUND_RECHECK_MS));
      const second = await read();
      if (second.focus) return second;
      // A thread already shown (or a later page, which only exists once the focus was read) stays
      // on screen: a read that can't find it is treated as failed, and the query keeps its data.
      if (pageParam !== null || hasLoadedFocus(id)) throw new Error('Thread unavailable');
      return second;
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
  // Not persisted: a failed read also answers `null`, and that must not outlive this session.
  return useEngineQuery(queryKeys.post.detail(id), (api) => api.posts.get(id), { enabled: id.length > 0 });
}
