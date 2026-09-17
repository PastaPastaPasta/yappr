import type { NotificationSettings } from '@/lib/store'
import type { Notification } from '@/lib/types'

const NOTIFICATION_TYPE_TO_SETTING: Record<Notification['type'], keyof NotificationSettings | null> = {
  like: 'likes',
  repost: 'reposts',
  reply: 'replies',
  follow: 'follows',
  mention: 'mentions',
  blogPost: 'blogPosts',
  // Private feed events have no preference and are always visible.
  privateFeedRequest: null,
  privateFeedApproved: null,
  privateFeedRevoked: null,
}

export function isNotificationEnabled(
  notification: Pick<Notification, 'type'>,
  settings: NotificationSettings
): boolean {
  const setting = NOTIFICATION_TYPE_TO_SETTING[notification.type]
  return setting === null || settings[setting]
}

export function getVisibleUnreadNotificationCount(
  notifications: Pick<Notification, 'type' | 'read'>[],
  settings: NotificationSettings
): number {
  return notifications.filter(notification => !notification.read && isNotificationEnabled(notification, settings)).length
}
