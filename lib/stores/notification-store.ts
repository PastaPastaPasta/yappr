import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Notification } from '../types';
import { scopedKey } from '@/lib/storage-scope';
import { isNotificationEnabled } from '@/lib/notification-preferences';
import type { NotificationSettings } from '@/lib/store';

// Maximum number of read IDs to store in localStorage
// At ~44 chars per base58 ID, 1000 IDs ≈ 44KB, well under localStorage limits
const MAX_READ_IDS = 1000;

/**
 * A held notification as the viewer may see it, given who they block: an
 * aggregated like loses just its blocked likers (the one shown and the count
 * follow) and goes only when none is left; anything else goes when its actor
 * is blocked. Null when nothing is left. Shared by the web store and the
 * mobile engine's live block filter.
 */
export function withoutBlockedActors(notification: Notification, isBlocked: (id: string) => boolean): Notification | null {
  const { likers } = notification;
  if (!likers) return isBlocked(notification.from.id) ? null : notification;
  const kept = likers.filter(liker => !isBlocked(liker.id));
  if (kept.length === likers.length) return notification;
  if (kept.length === 0) return null;
  const likerCount = Math.max(kept.length, (notification.likerCount ?? likers.length) - (likers.length - kept.length));
  return { ...notification, from: kept[0], likers: kept, likerCount };
}

function withoutSessionBlocks(notifications: Notification[], blockedActors: string[]): Notification[] {
  if (blockedActors.length === 0) return notifications;
  const blocked = new Set(blockedActors);
  return notifications.flatMap(n => withoutBlockedActors(n, id => blocked.has(id)) ?? []);
}

type NotificationFilter = 'all' | 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'blogPost' | 'store' | 'privateFeed';

/**
 * Add IDs to read set and prune if exceeds limit
 */
function addToReadIds(currentIds: string[], idsToAdd: string[]): string[] {
  const readIdsSet = new Set(currentIds);
  for (const id of idsToAdd) {
    readIdsSet.add(id);
  }
  const result = Array.from(readIdsSet);
  return result.length > MAX_READ_IDS ? result.slice(-MAX_READ_IDS) : result;
}

interface NotificationState {
  // Data
  notifications: Notification[];
  lastFetchTimestamp: number;

  /**
   * Unread direct messages across every conversation, for the Messages nav
   * badge. Refreshed by the same sidebar poll that drives `notifications` —
   * there is deliberately no second timer — and always 0 on the v3 DM topology,
   * where a total would cost a 100-message download per conversation per poll
   * (see directMessageService.getUnreadTotal).
   *
   * Not persisted: it is a live count, and a stale one from the last session
   * would show a badge for messages the user has since read.
   */
  dmUnreadCount: number;

  // Filter
  filter: NotificationFilter;

  // Loading states
  isLoading: boolean;
  hasFetchedOnce: boolean;

  // Read state (persisted)
  readIds: string[];

  /** The signed-in account the session state below belongs to. */
  viewerId: string | null;
  /**
   * Actors `viewerId` blocked during this session. A fetch that was already
   * running when the block landed must not bring them back, so every ingest
   * filters them (per liker, as {@link withoutBlockedActors}). Not persisted:
   * each fetch filters blocks itself; this only covers the ones in flight.
   */
  blockedActors: string[];

  // Actions
  setNotifications: (notifications: Notification[]) => void;
  addNotifications: (notifications: Notification[]) => void;
  /**
   * `viewerId` just blocked this actor: drop their held notifications and keep
   * them out of fetches still running. Ignored when another account is
   * signed in by now (a block that finished after a switch).
   */
  removeFromActor: (actorId: string, viewerId: string) => void;
  /** `viewerId` unblocked this actor: their new notifications show again. Ignored for another account. */
  allowActor: (actorId: string, viewerId: string) => void;
  /**
   * Drop the held notifications of actors `viewerId` blocks now, by any route
   * (own block or a followed block list), per liker. Ignored for another account.
   */
  pruneBlocked: (blockedIds: ReadonlySet<string>, viewerId: string) => void;
  /** The account signed in now (null when signed out); another account's session blocks are forgotten. */
  setViewer: (viewerId: string | null) => void;
  setFilter: (filter: NotificationFilter) => void;
  markAsRead: (id: string) => void;
  /**
   * Mark every notification the user can currently see as read. Types turned
   * off in `settings` are skipped, so they are still unread if re-enabled.
   */
  markAllAsRead: (settings: NotificationSettings) => void;
  setLoading: (loading: boolean) => void;
  setLastFetchTimestamp: (timestamp: number) => void;
  setHasFetchedOnce: (fetched: boolean) => void;
  setDmUnreadCount: (count: number) => void;
  clearNotifications: () => void;

  // Computed helpers
  getReadIdsSet: () => Set<string>;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      // Initial state
      notifications: [],
      lastFetchTimestamp: 0,
      filter: 'all',
      isLoading: false,
      hasFetchedOnce: false,
      readIds: [],
      viewerId: null,
      blockedActors: [],
      dmUnreadCount: 0,

      // Actions
      setNotifications: (notifications) => {
        const readIdsSet = new Set(get().readIds);
        const withReadStatus = withoutSessionBlocks(notifications, get().blockedActors).map(n => ({
          ...n,
          read: readIdsSet.has(n.id)
        }));
        set({ notifications: withReadStatus });
      },

      addNotifications: (newNotifications) => {
        const state = get();
        const existingIds = new Set(state.notifications.map(n => n.id));
        const readIdsSet = new Set(state.readIds);

        // Filter out duplicates and set read status
        const uniqueNew = withoutSessionBlocks(newNotifications, state.blockedActors)
          .filter(n => !existingIds.has(n.id))
          .map(n => ({
            ...n,
            read: readIdsSet.has(n.id)
          }));

        if (uniqueNew.length === 0) return;

        // Merge and sort by createdAt descending
        const merged = [...uniqueNew, ...state.notifications]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        set({ notifications: merged });
      },

      removeFromActor: (actorId, viewerId) => {
        const state = get();
        if (state.viewerId !== viewerId) return;
        set({
          notifications: withoutSessionBlocks(state.notifications, [actorId]),
          blockedActors: state.blockedActors.includes(actorId) ? state.blockedActors : [...state.blockedActors, actorId],
        });
      },

      setViewer: (viewerId) => {
        if (get().viewerId !== viewerId) set({ viewerId, blockedActors: [] });
      },

      pruneBlocked: (blockedIds, viewerId) => {
        const state = get();
        if (state.viewerId !== viewerId || blockedIds.size === 0) return;
        const notifications = state.notifications.flatMap(n => withoutBlockedActors(n, id => blockedIds.has(id)) ?? []);
        if (notifications.length !== state.notifications.length || notifications.some((n, i) => n !== state.notifications[i])) {
          set({ notifications });
        }
      },

      allowActor: (actorId, viewerId) => {
        const { blockedActors, viewerId: current } = get();
        if (current === viewerId && blockedActors.includes(actorId)) set({ blockedActors: blockedActors.filter(id => id !== actorId) });
      },

      setFilter: (filter) => set({ filter }),

      markAsRead: (id) => {
        const state = get();
        if (state.readIds.includes(id)) return;

        set({
          readIds: addToReadIds(state.readIds, [id]),
          notifications: state.notifications.map(n =>
            n.id === id ? { ...n, read: true } : n
          )
        });
      },

      markAllAsRead: (settings) => {
        const state = get();
        // Read state is per id, so leaving hidden ids out of readIds keeps them unread.
        const visibleIds = new Set(
          state.notifications.filter(n => isNotificationEnabled(n, settings)).map(n => n.id)
        );
        if (visibleIds.size === 0) return;

        set({
          readIds: addToReadIds(state.readIds, Array.from(visibleIds)),
          notifications: state.notifications.map(n =>
            visibleIds.has(n.id) ? { ...n, read: true } : n
          )
        });
      },

      setLoading: (isLoading) => set({ isLoading }),

      setLastFetchTimestamp: (timestamp) => set({ lastFetchTimestamp: timestamp }),

      setHasFetchedOnce: (fetched) => set({ hasFetchedOnce: fetched }),

      setDmUnreadCount: (dmUnreadCount) => set({ dmUnreadCount }),

      clearNotifications: () => set({
        notifications: [],
        lastFetchTimestamp: 0,
        blockedActors: [],
        dmUnreadCount: 0
      }),

      // Computed helpers
      getReadIdsSet: () => new Set(get().readIds)
    }),
    {
      name: scopedKey('yappr-notifications'),
      // Only persist read state and timestamp (not the full notifications array)
      partialize: (state) => ({
        readIds: state.readIds,
        lastFetchTimestamp: state.lastFetchTimestamp
      })
    }
  )
);
