import type { PostDTO, ThreadDTO, ThreadReplyDTO } from '@engine/api/dto';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { queryKeys } from '~/data/keys';
import { useEngineQuery, useFetchNextPageAfterRefetch, withRetriedError } from '~/data/queries';
import { engine } from '~/engine';
import { persistedQuery, queryClient } from '~/state/query-client';

/** How long to wait before re-reading a thread whose post came back missing. */
export const NOT_FOUND_RECHECK_MS = 3000;

/**
 * A re-read that twice came back without a focus this device already showed.
 * Thrown so the query keeps the thread it holds (lib answers a failed read as
 * "absent", so it may be transient), while the screen marks the focus
 * unavailable and takes no replies until a read finds it again.
 */
export class FocusUnavailableError extends Error {
  constructor() {
    super('The post could not be found');
    this.name = 'FocusUnavailableError';
  }
}

/** The thread this device holds: the latest cumulative page. */
function heldThread(id: string): ThreadDTO | undefined {
  const pages = queryClient.getQueryData<InfiniteData<ThreadDTO>>(queryKeys.post.thread(id))?.pages;
  return pages?.[pages.length - 1];
}

/**
 * `page` merged into the thread `held` (MARCH-5). A delta continuation
 * (`layout` set) brings only its new replies: the rest come from `held`,
 * with whatever marks this device put on them since (a like), and the focus
 * and ancestors stay as held. A reply keeps its object unless the layout
 * moved it. `null` when `held` lacks a reply the layout places; any other
 * page is the whole thread already.
 */
export function mergeThreadPage(held: ThreadDTO, page: ThreadDTO): ThreadDTO | null {
  const { layout } = page;
  if (!layout) return page;
  const known = new Map(held.replies.items.map((reply) => [reply.id, reply]));
  for (const reply of page.replies.items) known.set(reply.id, reply);
  const items: ThreadReplyDTO[] = [];
  for (const slot of layout) {
    const reply = known.get(slot.id);
    if (!reply) return null;
    const moved = reply.depth !== slot.depth || reply.isAuthorThread !== slot.isAuthorThread || reply.hiddenReplyCount !== slot.hiddenReplyCount;
    items.push(moved ? { ...reply, ...slot } : reply);
  }
  return { ...held, focus: held.focus ?? page.focus, replies: { ...page.replies, items } };
}

/**
 * A post's thread (`posts.thread`). Its pages are cumulative: each one holds
 * the whole thread loaded so far, re-nested, so the query keeps only the
 * latest page (`maxPages: 1`). "More replies" asks the engine for a delta,
 * which reads and hydrates only the new page, and merges it here
 * ({@link mergeThreadPage}). A refresh re-reads the latest page whole through
 * its own cursor, so the replies already loaded stay loaded. Persisted, so a
 * thread opened before paints at once on the next launch.
 */
export function useThread(id: string) {
  const query = useInfiniteQuery<ThreadDTO, Error, InfiniteData<ThreadDTO>, readonly unknown[], string | null>({
    ...persistedQuery,
    queryKey: queryKeys.post.thread(id),
    queryFn: async ({ pageParam, signal }) => {
      // Leaving the screen cancels the read in the engine (ENGINE.md §4.6).
      const api = engine.withSignal(signal);
      const read = async () => {
        const held = pageParam === null ? undefined : heldThread(id);
        if (held) {
          const merged = mergeThreadPage(held, await api.posts.thread(id, pageParam, { delta: true }));
          if (merged) return merged;
        }
        return api.posts.thread(id, pageParam);
      };
      const first = await read();
      if (first.focus) return first;
      // lib answers a failed single read as "absent" (on sakura, often a proof miss that clears in
      // seconds): ask once more before saying the post is gone.
      await new Promise((resolve) => setTimeout(resolve, NOT_FOUND_RECHECK_MS));
      const second = await read();
      if (second.focus) return second;
      // A thread already shown (or a later page, which only exists once the focus was read) keeps its
      // replies on screen: the read fails, the query keeps its data, and the screen marks the focus
      // unavailable (FocusUnavailableError).
      if (pageParam !== null || heldThread(id)?.focus) throw new FocusUnavailableError();
      return second;
    },
    initialPageParam: null,
    getNextPageParam: (last) => (last.replies.hasMore && last.replies.cursor ? last.replies.cursor : undefined),
    maxPages: 1,
    enabled: id.length > 0,
  });
  const thread = query.data?.pages[query.data.pages.length - 1];
  // Paging while a pull to refresh runs would cancel the refresh.
  const fetchNextPage = useFetchNextPageAfterRefetch(queryKeys.post.thread(id), query.fetchNextPage);
  return { ...withRetriedError(queryKeys.post.thread(id), query), thread, fetchNextPage };
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
