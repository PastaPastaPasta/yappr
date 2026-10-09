import { useEffect, useRef } from 'react';

import type { EngagementCountsDTO, PostDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery, usePullToRefresh } from '~/data/queries';
import type { RepostQuoteCounts } from '~/ui/post/PostCard';

/**
 * The detail counts row's reposts and quotes on v10 (`repostsAreQuotes`,
 * D-L4a-009). A bare repost there is a quote post, so `post.stats.quotes`
 * holds the bare reposts too (a repost made here and not read back yet sits
 * in `reposts`). `posts.engagementCounts` splits the quote list as web's
 * engagements page does. The total stays the card's, which optimistic
 * updates keep current: the read's quotes with text are the quotes and the
 * rest are reposts. A split of a list that filled up covers only its first
 * 100 posts, while the count tree counts them all, so it is shown as is, as
 * floors. `null` while the split is unknown.
 */
export function splitRepostCounts(
  stats: PostDTO['stats'],
  counts: EngagementCountsDTO | undefined,
): RepostQuoteCounts | null {
  if (stats.quotes === 0) return { reposts: stats.reposts, quotes: 0, truncated: false };
  if (!counts) return null;
  if (counts.truncated) return { reposts: counts.reposts, quotes: counts.quotes, truncated: true };
  const total = stats.reposts + stats.quotes;
  const quotes = Math.min(counts.quotes, total);
  return { reposts: total - quotes, quotes, truncated: false };
}

/** Whether `counts` split a different quote list than the one `stats` counts (one changed since). */
export function splitIsStale(stats: PostDTO['stats'], counts: EngagementCountsDTO | undefined): boolean {
  return counts !== undefined && !counts.truncated && counts.reposts + counts.quotes !== stats.quotes;
}

/**
 * `splitRepostCounts` for a detail card where reposts are quotes; `undefined`
 * elsewhere, and where the split could not be read (`post.stats` is right,
 * or the best there is).
 */
export function useRepostQuoteCounts(post: PostDTO, enabled: boolean): RepostQuoteCounts | null | undefined {
  const { id, kind, stats } = post;
  const read = enabled && stats.quotes > 0 && !post.deleted;
  // Past the engine's cached split while a re-split runs, its retry included: the quote list changed since.
  const fresh = usePullToRefresh();
  // The engagements screen reads the same query: opening it from the row shows these counts at once.
  const { data, isError, isFetching, refetch } = useEngineQuery(
    queryKeys.post.engagementCounts(id),
    (api) => api.posts.engagementCounts({ id, kind }, fresh.params().refresh === true),
    { enabled: read },
  );
  // A refresh (or someone's quote) moved the quote count: split the list again, once per count,
  // so a list that has not caught up yet is not read over and over.
  const stale = read && !isFetching && splitIsStale(stats, data);
  const rereadFor = useRef<number | null>(null);
  useEffect(() => {
    if (!stale || rereadFor.current === stats.quotes) return;
    rereadFor.current = stats.quotes;
    fresh.during(refetch).catch(() => undefined);
  }, [stale, stats.quotes, refetch, fresh]);
  if (!enabled || (isError && !data)) return undefined;
  return splitRepostCounts(stats, data);
}
