import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Notification } from '../types';

type NotificationFilter = 'all' | 'follow' | 'mention';

interface NotificationState {
  // Data
  notifications: Notification[];
  lastFetchTimestamp: number;

  // Filter
  filter: NotificationFilter;

  // Loading states
  isLoading: boolean;

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
  clearNotifications: () => void;

  // Computed helpers
  getUnreadCount: () => number;
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
        const readIdsSet = new Set(state.readIds);

        if (readIdsSet.has(id)) return;

        readIdsSet.add(id);
        const newReadIds = Array.from(readIdsSet);

        // Update notifications with new read status
        const updatedNotifications = state.notifications.map(n =>
          n.id === id ? { ...n, read: true } : n
        );

        set({
          readIds: newReadIds,
          notifications: updatedNotifications
        });
      },

      markAllAsRead: () => {
        const state = get();
        const readIdsSet = new Set(state.readIds);

        // Add all current notification IDs to read set
        for (const n of state.notifications) {
          readIdsSet.add(n.id);
        }

        const newReadIds = Array.from(readIdsSet);

        // Update all notifications to read
        const updatedNotifications = state.notifications.map(n => ({
          ...n,
          read: true
        }));

        set({
          readIds: newReadIds,
          notifications: updatedNotifications
        });
      },

      setLoading: (isLoading) => set({ isLoading }),

      setLastFetchTimestamp: (timestamp) => set({ lastFetchTimestamp: timestamp }),

      clearNotifications: () => set({
        notifications: [],
        lastFetchTimestamp: 0
      }),

      // Computed helpers
      getUnreadCount: () => {
        const state = get();
        return state.notifications.filter(n => !n.read).length;
      },

      getFilteredNotifications: () => {
        const state = get();
        if (state.filter === 'all') {
          return state.notifications;
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
