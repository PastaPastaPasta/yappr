import type { NotificationDTO, Page, SettingsDTO } from '@engine/api';
import type { InfiniteData } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { toast } from '~/ui/toast';

import type { MobileFilter } from './notification-model';
import { useAppActive } from './use-app-active';

/**
 * The notifications data: the list per filter, the tab badge with its
 * foreground poll (NOTIF-03), read marks (NOTIF-04) and the per-type
 * toggles (NOTIF-05). Never persisted (src/data/README.md).
 */

/** NOTIF-03: every 30 s while the app is in the foreground and signed in. */
export const POLL_INTERVAL_MS = 30_000;

/** The unread count of enabled types, from the engine's `notifications.count` and polls. */
export const useNotificationBadge = create<{ unread: number }>()(() => ({ unread: 0 }));

const setUnread = (unread: number) => useNotificationBadge.setState({ unread: Math.max(0, unread) });

type ListData = InfiniteData<Page<NotificationDTO>>;

/** Every loaded list, every filter. */
const refetchLists = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.notificationsAll }).catch(() => undefined);

let polling: { viewer: string | null; done: Promise<number | null> } | null = null;

/**
 * One poll (`notifications.poll`) for `viewer`: merges what arrived since
 * the last one, updates the badge, and refetches the lists when something
 * new came. A poll already running for the same account is joined, not
 * repeated; one left over from another account is not. Resolves with how
 * many arrived (the lists are refetched by then), or null when it failed
 * or belongs to an account no longer polled.
 */
export function pollNotifications(viewer: string | null): Promise<number | null> {
  if (polling?.viewer === viewer) return polling.done;
  const current = {
    viewer,
    done: engine.api.notifications
      .poll()
      .then(async ({ added, unread }) => {
        if (polling !== current) return null;
        setUnread(unread);
        if (added > 0) await refetchLists();
        return added;
      })
      .catch((error: unknown) => {
        appendLog('warn', 'host', `Notifications poll failed: ${errorMessage(error)}`);
        return null;
      })
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

  // Each account has its own read state: the old count means nothing to the next one.
  useEffect(() => setUnread(0), [viewerId]);

  useEngineEvent('notifications.count', ({ unread }) => {
    if (viewerId) setUnread(unread);
  });

  useEffect(() => {
    if (!viewerId || !active) return undefined;
    pollNotifications(viewerId).catch(() => undefined);
    const timer = setInterval(() => {
      pollNotifications(viewerId).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [viewerId, active]);

  const unread = useNotificationBadge((s) => s.unread);
  return viewerId ? unread : 0;
}

/** One filter of the list, 30 a page, newest first (`notifications.list`). */
export function useNotificationList(filter: MobileFilter, enabled: boolean) {
  return useEngineInfiniteQuery(
    queryKeys.notifications(filter),
    (api, cursor) => api.notifications.list({ filter, cursor }),
    { enabled },
  );
}

/** Settings are device-wide (PD-12): the toggles and the NSFW mode the snippets follow. */
export function useSettings() {
  return useEngineQuery(queryKeys.settings, (api) => api.settings.get());
}

/** Marks these ids read in every cached list; returns how many were unread. */
function patchRead(ids: ReadonlySet<string> | 'all'): number {
  const changed = new Set<string>();
  queryClient.setQueriesData<ListData>({ queryKey: queryKeys.notificationsAll }, (data) => {
    if (!data) return data;
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
    return touched ? { ...data, pages } : data;
  });
  return changed.size;
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
  const unread = patchRead(new Set(ids));
  if (unread > 0) setUnread(useNotificationBadge.getState().unread - unread);
  engine.api.notifications.markRead([...ids]).catch((error: unknown) => {
    appendLog('warn', 'host', `Marking notifications read failed: ${errorMessage(error)}`);
    resyncAfterFailedMark();
  });
}

/**
 * "Mark all as read" (NOTIF-04): only the enabled types, which are all the
 * lists hold; disabled types stay unread for when they're turned back on.
 */
export async function markAllNotificationsRead(): Promise<void> {
  patchRead('all');
  setUnread(0);
  try {
    await engine.api.notifications.markVisibleRead();
  } catch (error) {
    appendLog('warn', 'host', `Mark all as read failed: ${errorMessage(error)}`);
    toast.error("Couldn't mark notifications as read. Try again.");
    resyncAfterFailedMark();
  }
}

type Toggles = SettingsDTO['notificationSettings'];

/**
 * Turns one notification type on or off (NOTIF-05). Applied at once; the
 * lists refetch without (or with) that type, and the engine recounts the
 * badge. A refused change is undone.
 */
export async function setNotificationToggle(key: keyof Toggles, value: boolean): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  const previous = queryClient.getQueryData<SettingsDTO>(queryKeys.settings);
  if (previous) {
    queryClient.setQueryData<SettingsDTO>(queryKeys.settings, {
      ...previous,
      notificationSettings: { ...previous.notificationSettings, [key]: value },
    });
  }
  try {
    const next = await engine.api.settings.set({ notificationSettings: { [key]: value } });
    queryClient.setQueryData(queryKeys.settings, next);
  } catch (error) {
    appendLog('warn', 'host', `Saving a notification setting failed: ${errorMessage(error)}`);
    toast.error("Couldn't save the setting. Try again.");
    queryClient.invalidateQueries({ queryKey: queryKeys.settings }).catch(() => undefined);
  } finally {
    refetchLists();
  }
}
