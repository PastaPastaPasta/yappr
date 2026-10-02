import type { PostDTO, RankingWindow } from '@engine/api';
import type { FeedTab } from '@engine/api/feed';
import { hashKey, useIsRestoring } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { queryClient } from '~/state/query-client';

import {
  keepFirstPage,
  NEW_POSTS_LIMIT,
  newestTimestamp,
  prependToFirstPage,
  type FeedData,
} from './feed-data';
import type { FeedSort } from './home-prefs';

/** Web polls for new posts every 15 s (`use-feed-data.ts`). */
export const NEW_POSTS_POLL_MS = 15_000;

/** Feeds whose restored pages were cut to the first one this launch. */
const trimmedThisLaunch = new Set<string>();

export interface HomeFeedQuery {
  tab: FeedTab;
  sort: FeedSort;
  window: RankingWindow;
  /** Off while the feed cannot be read yet (Following before the session is restored). */
  enabled: boolean;
}

/**
 * One home feed (`feed.home`), kept on disk so a cold start paints it
 * before the engine is up (PRD FEED-11). It never refetches by itself: new
 * posts come in through the pill (`useNewPosts`), a pull to refresh, or the
 * data layer's refetch after the viewer posts, so the list does not
 * reshuffle under the reader's finger.
 */
export function useHomeFeed({ tab, sort, window, enabled }: HomeFeedQuery) {
  const key = queryKeys.feed.home({ tab, sort, window });
  const feed = useEngineInfiniteQuery(
    key,
    (api, cursor) => api.feed.home({ tab, sort, window, cursor }),
    { persist: true, enabled, staleTime: Infinity },
  );

  // A cold start shows the first page it saved, not every page read last time (a refetch would re-read them all).
  const isRestoring = useIsRestoring();
  const keyHash = hashKey(key);
  useEffect(() => {
    if (isRestoring || trimmedThisLaunch.has(keyHash)) return;
    trimmedThisLaunch.add(keyHash);
    queryClient.setQueryData<FeedData>(queryKeys.feed.home({ tab, sort, window }), keepFirstPage);
  }, [isRestoring, keyHash, tab, sort, window]);

  const { refetch } = feed;

  /**
   * Reload the first page only (a pull to refresh is at the top anyway).
   * Resolves with the error, if it failed; the pages read before stay.
   */
  const refresh = async (): Promise<Error | null> => {
    const queryKey = queryKeys.feed.home({ tab, sort, window });
    // A next page in flight would land on top of the trimmed pages.
    await queryClient.cancelQueries({ queryKey, exact: true });
    const before = queryClient.getQueryData<FeedData>(queryKey);
    queryClient.setQueryData<FeedData>(queryKey, keepFirstPage);
    const result = await refetch();
    if (result.error && before) queryClient.setQueryData<FeedData>(queryKey, before);
    return result.error;
  };

  /**
   * Put the pill's posts on top of the list. A full answer may have a gap
   * behind it, so that one reloads the first page instead.
   */
  const insertNew = async (posts: readonly PostDTO[]): Promise<Error | null> => {
    if (posts.length >= NEW_POSTS_LIMIT) return refresh();
    queryClient.setQueryData<FeedData>(queryKeys.feed.home({ tab, sort, window }), (data) =>
      prependToFirstPage(data, posts),
    );
    return null;
  };

  return { ...feed, refresh, insertNew };
}

/**
 * The posts newer than the feed's newest (`feed.checkNew`), polled every
 * 15 s while `enabled`, and once at once whenever it turns on (return to the
 * app or to Home, PRD FEED-05). Each answer is the whole set since the
 * feed's newest post, so nothing accumulates here; inserting them moves the
 * newest and starts over. `items` are the feed's own; `shown` adds what the
 * screen puts above them (the viewer's pinned posts), which the pill skips.
 */
export function useNewPosts({
  tab,
  items,
  shown,
  enabled,
}: {
  tab: FeedTab;
  items: readonly PostDTO[];
  shown: readonly PostDTO[];
  enabled: boolean;
}): PostDTO[] {
  const since = newestTimestamp(items) ?? 0;
  // The ids from the overlap window the engine re-reads; the newest are first.
  const knownIds = items.slice(0, NEW_POSTS_LIMIT).map((item) => item.id);
  const { data } = useEngineQuery(
    queryKeys.feed.newPosts(tab, since),
    (api) => api.feed.checkNew({ tab, since: new Date(since), knownIds }),
    {
      enabled: enabled && since > 0,
      refetchInterval: NEW_POSTS_POLL_MS,
      staleTime: 0,
      retry: false,
    },
  );
  return useMemo(() => {
    const seen = new Set(shown.map((item) => item.id));
    return (data?.posts ?? []).filter((post) => !seen.has(post.id));
  }, [data, shown]);
}
