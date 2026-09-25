import { describe, expect, it } from 'vitest'
import { getVisibleUnreadNotificationCount, isNotificationEnabled } from './notification-preferences'
import type { NotificationSettings } from './store'
import type { Notification } from './types'

const enabled: NotificationSettings = {
  likes: true, reposts: true, replies: true, follows: true,
  mentions: true, messages: true, blogPosts: true,
}

describe('notification visibility and unread counts', () => {
  it.each([
    ['like', 'likes'], ['repost', 'reposts'], ['reply', 'replies'],
    ['follow', 'follows'], ['mention', 'mentions'], ['blogPost', 'blogPosts'],
    ['blogComment', 'blogPosts'],
  ] as const)('excludes disabled %s notifications from the unread count', (type, setting) => {
    const notification = { type, read: false }
    expect(getVisibleUnreadNotificationCount([notification], enabled)).toBe(1)
    const disabled = { ...enabled, [setting]: false }
    expect(isNotificationEnabled(notification, disabled)).toBe(false)
    expect(getVisibleUnreadNotificationCount([notification], disabled)).toBe(0)
    // Preference changes must not consume unread state; re-enabling restores it.
    expect(notification.read).toBe(false)
    expect(getVisibleUnreadNotificationCount([notification], enabled)).toBe(1)
  })

  it('retains private feed events even when every preference is disabled', () => {
    const disabled = Object.fromEntries(Object.keys(enabled).map(key => [key, false])) as unknown as NotificationSettings
    const notifications = ['privateFeedRequest', 'privateFeedApproved', 'privateFeedRevoked']
      .map(type => ({ type: type as Notification['type'], read: false }))
    expect(notifications.every(notification => isNotificationEnabled(notification, disabled))).toBe(true)
    expect(getVisibleUnreadNotificationCount(notifications, disabled)).toBe(3)
  })

  it('counts only unread enabled events in a mixed list without altering read state', () => {
    const notifications = [
      { type: 'like' as const, read: false },
      { type: 'follow' as const, read: false },
      { type: 'reply' as const, read: true },
      { type: 'privateFeedRequest' as const, read: false },
    ]
    expect(getVisibleUnreadNotificationCount(notifications, { ...enabled, likes: false })).toBe(2)
    expect(getVisibleUnreadNotificationCount(notifications, enabled)).toBe(3)
    expect(notifications.map(notification => notification.read)).toEqual([false, false, true, false])
    notifications[0].read = true
    expect(getVisibleUnreadNotificationCount(notifications, enabled)).toBe(2)
  })
})
