import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Notification } from '../types';
import { scopedKey } from '@/lib/storage-scope';
import { isNotificationEnabled } from '@/lib/notification-preferences';
import type { NotificationSettings } from '@/lib/store';

// Maximum number of read IDs to store in localStorage
// At ~44 chars per base58 ID, 1000 IDs ≈ 44KB, well under localStorage limits
const MAX_READ_IDS = 1000;

type NotificationFilter = 'all' | 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'blogPost' | 'privateFeed';

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

  // Actions
  setNotifications: (notifications: Notification[]) => void;
  addNotifications: (notifications: Notification[]) => void;
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
      dmUnreadCount: 0,

      // Actions
      setNotifications: (notifications) => {
        const readIdsSet = new Set(get().readIds);
        const withReadStatus = notifications.map(n => ({
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
        const uniqueNew = newNotifications
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
