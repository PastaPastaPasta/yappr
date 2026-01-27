import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Notification } from '../types';

// Maximum number of read IDs to store in localStorage
// At ~44 chars per base58 ID, 1000 IDs ≈ 44KB, well under localStorage limits
const MAX_READ_IDS = 1000;

type NotificationFilter = 'all' | 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'privateFeed';

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
  markAllAsRead: () => void;
  setLoading: (loading: boolean) => void;
  setLastFetchTimestamp: (timestamp: number) => void;
  setHasFetchedOnce: (fetched: boolean) => void;
  clearNotifications: () => void;

  // Computed helpers
  getUnreadCount: () => number;
  getUnreadCountByFilter: (filter: NotificationFilter) => number;
  getFilteredNotifications: () => Notification[];
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

      markAllAsRead: () => {
        const state = get();
        const allIds = state.notifications.map(n => n.id);

        set({
          readIds: addToReadIds(state.readIds, allIds),
          notifications: state.notifications.map(n => ({ ...n, read: true }))
        });
      },

      setLoading: (isLoading) => set({ isLoading }),

      setLastFetchTimestamp: (timestamp) => set({ lastFetchTimestamp: timestamp }),

      setHasFetchedOnce: (fetched) => set({ hasFetchedOnce: fetched }),

      clearNotifications: () => set({
        notifications: [],
        lastFetchTimestamp: 0
      }),

      // Computed helpers
      getUnreadCount: () => {
        const state = get();
        return state.notifications.filter(n => !n.read).length;
      },

      getUnreadCountByFilter: (filter: NotificationFilter) => {
        const state = get();
        const unread = state.notifications.filter(n => !n.read);
        if (filter === 'all') {
          return unread.length;
        }
        if (filter === 'privateFeed') {
          return unread.filter(n =>
            n.type === 'privateFeedRequest' ||
            n.type === 'privateFeedApproved' ||
            n.type === 'privateFeedRevoked'
          ).length;
        }
        return unread.filter(n => n.type === filter).length;
      },

      getFilteredNotifications: () => {
        const state = get();
        if (state.filter === 'all') {
          return state.notifications;
        }
        // Handle private feed filter - matches all private feed notification types
        if (state.filter === 'privateFeed') {
          return state.notifications.filter(n =>
            n.type === 'privateFeedRequest' ||
            n.type === 'privateFeedApproved' ||
            n.type === 'privateFeedRevoked'
          );
        }
        // Handle engagement filters (like, repost, reply)
        if (state.filter === 'like' || state.filter === 'repost' || state.filter === 'reply') {
          return state.notifications.filter(n => n.type === state.filter);
        }
        return state.notifications.filter(n => n.type === state.filter);
      },

      getReadIdsSet: () => new Set(get().readIds)
    }),
    {
      name: 'yappr-notifications',
      // Only persist read state and timestamp (not the full notifications array)
      partialize: (state) => ({
        readIds: state.readIds,
        lastFetchTimestamp: state.lastFetchTimestamp
      })
    }
  )
);
