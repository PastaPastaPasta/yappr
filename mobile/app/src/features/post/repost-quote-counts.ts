import type { EngagementCountsDTO, PostDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import type { RepostQuoteCounts } from '~/ui/post/PostCard';

/**
 * The detail counts row's reposts and quotes on v10 (`repostsAreQuotes`,
 * D-L4a-009). A bare repost there is a quote post, so `post.stats.quotes`
 * holds the bare reposts too (a repost made here and not read back yet sits
 * in `reposts`). `posts.engagementCounts` splits the quote list as web's
 * engagements page does. The total stays the card's, which optimistic
 * updates keep current: the read's quotes with text are the quotes and the
 * rest are reposts. `null` while the split is unknown.
 */
export function splitRepostCounts(
  stats: PostDTO['stats'],
  counts: EngagementCountsDTO | undefined,
): RepostQuoteCounts | null {
  if (stats.quotes === 0) return { reposts: stats.reposts, quotes: 0, truncated: false };
  if (!counts) return null;
  const total = stats.reposts + stats.quotes;
  const quotes = Math.min(counts.quotes, total);
  return { reposts: total - quotes, quotes, truncated: counts.truncated };
}

/** `splitRepostCounts` for a detail card where reposts are quotes; `undefined` elsewhere (`post.stats` is right). */
export function useRepostQuoteCounts(post: PostDTO, enabled: boolean): RepostQuoteCounts | null | undefined {
  const { id, kind } = post;
  const read = enabled && post.stats.quotes > 0 && !post.deleted;
  // The engagements screen reads the same query: opening it from the row shows these counts at once.
  const { data } = useEngineQuery(
    queryKeys.post.engagementCounts(id),
    (api) => api.posts.engagementCounts({ id, kind }),
    { enabled: read },
  );
  return enabled ? splitRepostCounts(post.stats, data) : undefined;
}
