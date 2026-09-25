import { getVisibleUnreadNotificationCount } from '@/lib/notification-preferences'
import { useSettingsStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'

/** Unread notification count for nav badges, excluding types the user has disabled. */
export function useVisibleUnreadNotificationCount(): number {
  const notificationSettings = useSettingsStore((s) => s.notificationSettings)
  const notifications = useNotificationStore((s) => s.notifications)
  return getVisibleUnreadNotificationCount(notifications, notificationSettings)
}
