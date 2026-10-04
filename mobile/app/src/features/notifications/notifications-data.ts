import type { NotificationDTO, Page } from '@engine/api';
import type { InfiniteData } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { useAppActive } from '~/features/home/use-app-active';
import { queryClient } from '~/state/query-client';
import { toast } from '~/ui/toast';

import type { MobileFilter } from './notification-model';

/**
 * The notifications data: the list per filter, the tab badge with its
 * foreground poll (NOTIF-03), and read marks (NOTIF-04). Never persisted
 * (src/data/README.md). The per-type toggles (NOTIF-05) are saved by
 * `~/features/settings/settings-data`.
 */

/** NOTIF-03: every 30 s while the app is in the foreground and signed in. */
export const POLL_INTERVAL_MS = 30_000;

/**
 * The unread count of enabled types, from the engine's `notifications.count`
 * and polls, with the account it belongs to. Each account has its own read
 * state, so the count is only read for that account (`useUnreadCount`): the
 * next one never sees it, not even for the render before its own count lands.
 */
export const useNotificationBadge = create<{ viewer: string | null; unread: number }>()(() => ({
  viewer: null,
  unread: 0,
}));

/** Sets the count, for `viewer` (by default the account it already belongs to: read marks). */
const setUnread = (unread: number, viewer = useNotificationBadge.getState().viewer) =>
  useNotificationBadge.setState({ viewer, unread: Math.max(0, unread) });

/** The unread count for `viewer`; 0 signed out, or while the count is still another account's. */
export function useUnreadCount(viewer: string | null): number {
  return useNotificationBadge((s) => (viewer !== null && s.viewer === viewer ? s.unread : 0));
}

type ListData = InfiniteData<Page<NotificationDTO>>;

/** Every loaded list, every filter. */
const refetchLists = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.notificationsAll }).catch(() => undefined);

/** The lists left on their error, such as a failed first load (G-11). */
const refetchFailedLists = () =>
  queryClient
    .invalidateQueries({ queryKey: queryKeys.notificationsAll, predicate: (query) => query.state.status === 'error' })
    .catch(() => undefined);

let polling: { viewer: string | null; done: Promise<boolean> } | null = null;

/**
 * One poll (`notifications.poll`) for `viewer`: merges what arrived since
 * the last one, updates the badge, and refetches the lists when something
 * new came or a block or unblock changed what they show. Otherwise it still
 * refetches a list left on its error: the poll may just have made the first
 * load that list failed, and "none" is then its answer. A poll already
 * running for the same account is joined, not repeated; one left over from
 * another account is not. Resolves with whether it refetched the lists
 * (done by then; false for an account no longer polled), and rejects when
 * the poll failed.
 */
export function pollNotifications(viewer: string | null): Promise<boolean> {
  if (polling?.viewer === viewer) return polling.done;
  const current = {
    viewer,
    done: engine.api.notifications
      .poll()
      .then(
        async ({ added, unread, blockedChanged }) => {
          if (polling !== current) return false;
          setUnread(unread, viewer);
          if (added === 0 && !blockedChanged) {
            await refetchFailedLists();
            return false;
          }
          await refetchLists();
          return true;
        },
        (error: unknown) => {
          appendLog('warn', 'host', `Notifications poll failed: ${errorMessage(error)}`);
          throw error;
        },
      )
      .finally(() => {
        if (polling === current) polling = null;
      }),
  };
  polling = current;
  return current.done;
}

/**
 * The Notifications tab badge (`useTabBadges`). Signed in and in the
 * foreground, it polls at once (launch, sign-in, return to the foreground)
 * and then every 30 s; nothing runs in the background (NET-08). Signed out,
 * it's hidden (NOTIF-09).
 */
export function useNotificationsBadge(): number {
  const viewerId = useViewerId();
  const active = useAppActive();

  // The count stays with its account (`useUnreadCount`), so the tab bar remounting (an Android
  // font-scale or other configuration change recreates the activity) keeps it until the next
  // poll lands, instead of hiding the badge until then (D-L4a-008), and the next account starts
  // from 0, never from the last one's count.
  useEngineEvent('notifications.count', ({ unread }) => {
    if (viewerId) setUnread(unread, viewerId);
  });

  useEffect(() => {
    if (!viewerId || !active) return undefined;
    pollNotifications(viewerId).catch(() => undefined);
    const timer = setInterval(() => {
      pollNotifications(viewerId).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [viewerId, active]);

  return useUnreadCount(viewerId);
}

/** One filter of the list, 30 a page, newest first (`notifications.list`). */
export function useNotificationList(filter: MobileFilter, enabled: boolean) {
  return useEngineInfiniteQuery(
    queryKeys.notifications(filter),
    (api, cursor) => api.notifications.list({ filter, cursor }),
    { enabled },
  );
}

/**
 * Marks these ids read in every cached list; returns how many were unread.
 * Any list fetch in flight, a first one with nothing cached included, may
 * have read them unread, so it is cancelled (reverting to the data before
 * it) and can't land over the mark; `cancelled` says to refetch once the
 * engine holds the mark.
 */
function patchRead(ids: ReadonlySet<string> | 'all'): { unread: number; cancelled: boolean } {
  const changed = new Set<string>();
  let cancelled = false;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.notificationsAll })) {
    if (query.state.fetchStatus === 'fetching') {
      cancelled = true;
      queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined);
    }
    const data = queryClient.getQueryData<ListData>(query.queryKey);
    if (!data) continue;
    let touched = false;
    const pages = data.pages.map((page) => {
      if (!page.items.some((item) => !item.read && (ids === 'all' || ids.has(item.id)))) return page;
      touched = true;
      return {
        ...page,
        items: page.items.map((item) => {
          if (item.read || (ids !== 'all' && !ids.has(item.id))) return item;
          changed.add(item.id);
          return { ...item, read: true };
        }),
      };
    });
    if (!touched) continue;
    queryClient.setQueryData<ListData>(query.queryKey, { ...data, pages }, { updatedAt: query.state.dataUpdatedAt });
  }
  return { unread: changed.size, cancelled };
}

/** After a refused read mark: the lists and badge go back to what the engine holds. */
function resyncAfterFailedMark(): void {
  refetchLists();
  engine.api.notifications
    .unreadCount()
    .then(setUnread)
    .catch(() => undefined);
}

/**
 * A tapped row's notifications are read (NOTIF-01). Shown at once; the
 * engine's `notifications.count` then settles the badge. A refused mark is
 * undone quietly: the row opened anyway, and it shows unread again.
 */
export function markNotificationsRead(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const { unread, cancelled } = patchRead(new Set(ids));
  if (unread > 0) setUnread(useNotificationBadge.getState().unread - unread);
  engine.api.notifications.markRead([...ids]).then(
    () => {
      if (cancelled) refetchLists();
    },
    (error: unknown) => {
      appendLog('warn', 'host', `Marking notifications read failed: ${errorMessage(error)}`);
      resyncAfterFailedMark();
    },
  );
}

/**
 * "Mark all as read" (NOTIF-04): only the enabled types, which are all the
 * lists hold; disabled types stay unread for when they're turned back on.
 */
export async function markAllNotificationsRead(): Promise<void> {
  const { cancelled } = patchRead('all');
  setUnread(0);
  try {
    await engine.api.notifications.markVisibleRead();
    if (cancelled) refetchLists();
  } catch (error) {
    appendLog('warn', 'host', `Mark all as read failed: ${errorMessage(error)}`);
    toast.error("Couldn't mark notifications as read. Try again.");
    resyncAfterFailedMark();
  }
}
