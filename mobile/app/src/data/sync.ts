import type { ContentCreatedEvent, Page, PostDTO } from '@engine/api';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';

import { engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient, refetchFailedReads } from '~/state/query-client';

import { startConnectivity } from './connectivity';
import { onEngineEvent } from './events';
import { queryKeys } from './keys';
import { useRemovedPosts } from './optimistic';
import { startReadRetry } from './read-retry';
import { startReconciler } from './reconcile';
import { startSessionSync, useSessionStore } from './session';
import { adoptRestoredWrites, resetWriteTracking, startWriteTracking } from './writes';

/** Every `feed.home` query: the prefix of `queryKeys.feed.home(...)`. */
const homeFeeds = [...queryKeys.feed.all, 'home'] as const;

/** Whether a `feed.home` key (`[engine, network, 'feed', 'home', {tab, sort, window}]`) is a Recent tab. */
const isRecentHomeFeed = (queryKey: QueryKey): boolean =>
  (queryKey[4] as { sort?: unknown } | undefined)?.sort === 'recent';

/**
 * Put a post the viewer just published at the top of every loaded Recent
 * home feed, as web's feed does (`use-feed-data.ts` on `post-created`), or
 * replace the copy a feed already holds. Top sorts are rankings: a new post
 * is not in them.
 */
function insertIntoHomeFeeds(post: PostDTO): void {
  const feeds = queryClient.getQueriesData<InfiniteData<Page<PostDTO>>>({ queryKey: homeFeeds });
  for (const [queryKey, data] of feeds) {
    if (!isRecentHomeFeed(queryKey) || !data?.pages.length) continue;
    const held = data.pages.some((page) => page.items.some((item) => item.id === post.id));
    const pages = held
      ? data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === post.id ? post : item)) }))
      : [{ ...data.pages[0], items: [post, ...data.pages[0].items] }, ...data.pages.slice(1)];
    queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(queryKey, { ...data, pages });
  }
}

/**
 * A post or reply this device published: seed its detail, show a post at the
 * top of the Recent home feeds, and refetch the author's profile header and
 * the thread and quoted post it belongs to.
 *
 * Feeds and the author's profile tabs are only marked stale, never refetched
 * here: refetching an infinite query re-reads every page it holds, one after
 * another, and reshuffles the list under the reader. They refresh on their
 * next refetch (pull to refresh, a remount).
 */
function contentCreated({ kind, post }: ContentCreatedEvent): void {
  queryClient.setQueryData(queryKeys.post.detail(post.id), post);
  if (kind === 'post') insertIntoHomeFeeds(post);
  const profile = queryKeys.profile.detail(post.author.id);
  // The feeds and the author's profile tabs (paged) are marked stale; the profile header refetches.
  for (const queryKey of [queryKeys.feed.all, profile]) {
    queryClient.invalidateQueries({ queryKey, refetchType: 'none' }).catch(() => undefined);
  }
  queryClient.invalidateQueries({ queryKey: profile, exact: true }).catch(() => undefined);
  for (const id of [post.parentId, post.rootPostId, post.quotedPostId]) {
    if (id) queryClient.invalidateQueries({ queryKey: queryKeys.post.detail(id) }).catch(() => undefined);
  }
}

/**
 * The app-wide engine subscriptions: the session store, write tickets (and
 * their reconciler's foreground and read triggers), created content, and the
 * re-reads of failed reads (connectivity, the engine coming up, NET-03's
 * backoff). The root layout starts it once; returns the stop.
 */
export function startDataLayer(): () => void {
  // Another account's writes and deletes mean nothing to the next one.
  const stopAccount = useSessionStore.subscribe((state, previous) => {
    if (previous.status !== 'unknown' && state.session?.identityId !== previous.session?.identityId) {
      resetWriteTracking();
      useRemovedPosts.setState({ ids: new Set() });
    }
  });
  // A new engine restores the tickets of writes its predecessor's restart cut short.
  let epoch = engineSupervisor.getStatus().epoch;
  const stopRestored = engineSupervisor.subscribeStatus(() => {
    const status = engineSupervisor.getStatus();
    if (status.epoch === epoch || (status.state !== 'ready' && status.state !== 'degraded')) return;
    epoch = status.epoch;
    adoptRestoredWrites().catch((error: unknown) =>
      appendLog('warn', 'host', `Reading restored writes failed: ${errorMessage(error)}`),
    );
  });
  // The engine came up (a boot, a restart, a degraded boot that finished): reads that failed
  // while it could not answer are read again once (PRD NET-04: visible reads resume by themselves).
  let ready = engineSupervisor.getStatus().state === 'ready';
  let readyEpoch = engineSupervisor.getStatus().epoch;
  const stopReady = engineSupervisor.subscribeStatus(() => {
    const status = engineSupervisor.getStatus();
    const nowReady = status.state === 'ready';
    const cameUp = nowReady && (!ready || status.epoch !== readyEpoch);
    ready = nowReady;
    readyEpoch = status.epoch;
    if (!cameUp) return;
    refetchFailedReads('Engine ready').catch((error: unknown) =>
      appendLog('warn', 'host', `Reading again after the engine came up failed: ${errorMessage(error)}`),
    );
  });
  const stops = [
    startSessionSync(),
    startWriteTracking(),
    startReconciler(),
    startConnectivity(),
    startReadRetry(),
    onEngineEvent('content.created', contentCreated),
    stopAccount,
    stopRestored,
    stopReady,
  ];
  return () => stops.forEach((stop) => stop());
}
