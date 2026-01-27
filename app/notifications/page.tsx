'use client'

import { motion } from 'framer-motion'
import {
  UserPlusIcon,
  BellIcon,
  Cog6ToothIcon,
  AtSymbolIcon,
  LockClosedIcon,
  LockOpenIcon,
  ShieldExclamationIcon,
  HeartIcon,
  ArrowPathRoundedSquareIcon,
  ChatBubbleLeftIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { withAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { UserAvatar } from '@/components/ui/avatar-image'
import Link from 'next/link'
import { useNotificationStore } from '@/lib/stores/notification-store'
import { Notification } from '@/lib/types'

/**
 * Get the URL to navigate to when clicking a notification.
 * For reply notifications, navigates to the parent post (so you can see the reply in context).
 * For like/repost/mention notifications, navigates to the relevant post.
 * Returns null for follow and private feed notifications (no associated post).
 */
function getNotificationUrl(notification: Notification): string | null {
  // Follow and private feed notifications don't have an associated post
  if (
    notification.type === 'follow' ||
    notification.type === 'privateFeedRequest' ||
    notification.type === 'privateFeedApproved' ||
    notification.type === 'privateFeedRevoked'
  ) {
    return null
  }

  // For reply notifications, navigate to the parent post (where the reply appears)
  // The post.parentId contains the ID of the post/reply that was replied to
  if (notification.type === 'reply' && notification.post?.parentId) {
    return `/post?id=${notification.post.parentId}`
  }

  // For like, repost, mention - navigate to the post itself
  if (notification.post) {
    return `/post?id=${notification.post.id}`
  }

  return null
}

// Map notification types to settings keys
const NOTIFICATION_TYPE_TO_SETTING: Record<Notification['type'], string | null> = {
  like: 'likes',
  repost: 'reposts',
  reply: 'replies',
  follow: 'follows',
  mention: 'mentions',
  // Private feed notifications always show (no setting)
  privateFeedRequest: null,
  privateFeedApproved: null,
  privateFeedRevoked: null,
}

type NotificationFilter = 'all' | 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'privateFeed'

const FILTER_TABS: { key: NotificationFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'like', label: 'Likes' },
  { key: 'repost', label: 'Reposts' },
  { key: 'reply', label: 'Replies' },
  { key: 'follow', label: 'Follows' },
  { key: 'mention', label: 'Mentions' },
  { key: 'privateFeed', label: 'Private' }
]

const NOTIFICATION_ICONS: Record<Notification['type'], JSX.Element> = {
  follow: <UserPlusIcon className="h-5 w-5 text-purple-500" />,
  mention: <AtSymbolIcon className="h-5 w-5 text-yellow-500" />,
  like: <HeartIcon className="h-5 w-5 text-red-500" />,
  repost: <ArrowPathRoundedSquareIcon className="h-5 w-5 text-green-500" />,
  reply: <ChatBubbleLeftIcon className="h-5 w-5 text-blue-500" />,
  privateFeedRequest: <LockClosedIcon className="h-5 w-5 text-blue-500" />,
  privateFeedApproved: <LockOpenIcon className="h-5 w-5 text-green-500" />,
  privateFeedRevoked: <ShieldExclamationIcon className="h-5 w-5 text-red-500" />
}

const NOTIFICATION_MESSAGES: Record<Notification['type'], string> = {
  follow: 'started following you',
  mention: 'mentioned you in a post',
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'replied to your post',
  privateFeedRequest: 'requested access to your private feed',
  privateFeedApproved: 'approved your private feed request',
  privateFeedRevoked: 'revoked your private feed access'
}

const EMPTY_STATE_MESSAGES: Record<NotificationFilter, string> = {
  all: 'When someone interacts with you, you\'ll see it here',
  like: 'When someone likes your post, you\'ll see it here',
  repost: 'When someone reposts your post, you\'ll see it here',
  reply: 'When someone replies to your post, you\'ll see it here',
  follow: 'When someone follows you, you\'ll see it here',
  mention: 'When someone mentions you, you\'ll see it here',
  privateFeed: 'Private feed requests and updates will appear here'
}

function formatTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days < 7) return `${days}d`
  return date.toLocaleDateString()
}

function NotificationsPage() {
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  // Store - polling is handled by Sidebar, we just display data
  const filter = useNotificationStore((s) => s.filter)
  const isLoading = useNotificationStore((s) => s.isLoading)
  const hasFetchedOnce = useNotificationStore((s) => s.hasFetchedOnce)
  const setFilter = useNotificationStore((s) => s.setFilter)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead)
  // Subscribe to notifications array directly so component re-renders when markAllAsRead updates it
  // This fixes the bug where tab indicators didn't clear when marking all as read
  const notifications = useNotificationStore((s) => s.notifications)

  // Get notification settings from settings store
  const notificationSettings = useSettingsStore((s) => s.notificationSettings)

  // Filter notifications by current tab
  const getFilteredByTab = (notifs: Notification[], tabFilter: NotificationFilter) => {
    if (tabFilter === 'all') return notifs
    if (tabFilter === 'privateFeed') {
      return notifs.filter(n =>
        n.type === 'privateFeedRequest' ||
        n.type === 'privateFeedApproved' ||
        n.type === 'privateFeedRevoked'
      )
    }
    return notifs.filter(n => n.type === tabFilter)
  }

  // Get unread count for a specific filter, respecting user settings
  const getUnreadCountForTab = (tabFilter: NotificationFilter) => {
    const unread = notifications.filter(n => {
      if (n.read) return false
      // Respect notification settings (private feed notifications always count)
      const settingKey = NOTIFICATION_TYPE_TO_SETTING[n.type]
      if (settingKey !== null && !notificationSettings[settingKey as keyof typeof notificationSettings]) {
        return false
      }
      return true
    })
    return getFilteredByTab(unread, tabFilter).length
  }

  // Filter by tab first, then by user settings
  const tabFilteredNotifications = getFilteredByTab(notifications, filter)
  const filteredNotifications = tabFilteredNotifications.filter((notification) => {
    const settingKey = NOTIFICATION_TYPE_TO_SETTING[notification.type]
    // If no setting key (e.g., private feed notifications), always show
    if (settingKey === null) return true
    // Check if this notification type is enabled in settings
    return notificationSettings[settingKey as keyof typeof notificationSettings]
  })
  // Overall unread count respecting user settings
  const unreadCount = notifications.filter(n => {
    if (n.read) return false
    const settingKey = NOTIFICATION_TYPE_TO_SETTING[n.type]
    if (settingKey !== null && !notificationSettings[settingKey as keyof typeof notificationSettings]) {
      return false
    }
    return true
  }).length

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="flex items-center justify-between px-4 py-3">
            <h1 className="text-xl font-bold">Notifications</h1>
            <Link
              href="/settings?section=notifications"
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
            >
              <Cog6ToothIcon className="h-5 w-5" />
            </Link>
          </div>

          <div className="flex border-b border-gray-200 dark:border-gray-800">
            {FILTER_TABS.map((tab) => {
              const tabUnreadCount = getUnreadCountForTab(tab.key)
              return (
                <button
                  key={tab.key}
                  data-testid={`notification-tab-${tab.key}`}
                  onClick={() => setFilter(tab.key)}
                  className={`flex-1 py-4 text-sm font-medium transition-colors relative ${
                    filter === tab.key
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {tab.label}
                    {tabUnreadCount > 0 && (
                      <span className="w-2 h-2 bg-yappr-500 rounded-full" />
                    )}
                  </span>
                  {filter === tab.key && (
                    <motion.div
                      layoutId="notificationTab"
                      className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </header>

        {unreadCount > 0 && (
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllAsRead}
              className="text-yappr-500 hover:text-yappr-600"
            >
              Mark all as read
            </Button>
          </div>
        )}

        {isLoading || !hasFetchedOnce ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading notifications...</p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="p-8 text-center">
            <BellIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No notifications yet</p>
            <p className="text-sm text-gray-400 mt-2">
              {EMPTY_STATE_MESSAGES[filter]}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {filteredNotifications.map((notification) => (
              <motion.div
                key={notification.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={() => {
                  if (!notification.read) {
                    markAsRead(notification.id)
                  }
                }}
                className={`p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors cursor-pointer ${
                  !notification.read ? 'bg-yappr-50/20 dark:bg-yappr-950/10' : ''
                }`}
              >
                <div className="flex gap-3">
                  <div className="mt-1">
                    {NOTIFICATION_ICONS[notification.type] || <BellIcon className="h-5 w-5 text-gray-500" />}
                  </div>

                  <div className="flex-1">
                    <div className="flex items-start gap-3">
                      <Link
                        href={`/user?id=${notification.from?.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="h-10 w-10 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0"
                      >
                        <UserAvatar userId={notification.from?.id || ''} size="md" alt="User avatar" />
                      </Link>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm flex-1">
                            <Link
                              href={`/user?id=${notification.from?.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="font-semibold hover:underline"
                            >
                              {notification.from?.displayName || notification.from?.username || 'Unknown User'}
                            </Link>
                            {' '}
                            {NOTIFICATION_MESSAGES[notification.type] || 'interacted with you'}
                            <span className="text-gray-500 ml-2">
                              {formatTime(notification.createdAt)}
                            </span>
                          </p>

                          {/* Action buttons for private feed notifications */}
                          {notification.type === 'privateFeedRequest' && (
                            <Link
                              href="/settings?section=privateFeed"
                              onClick={(e) => e.stopPropagation()}
                              className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-950 dark:hover:bg-blue-900 rounded-full transition-colors flex-shrink-0"
                            >
                              View Requests
                            </Link>
                          )}
                          {notification.type === 'privateFeedApproved' && (
                            <Link
                              href={`/user?id=${notification.from?.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="px-3 py-1 text-xs font-medium text-green-600 bg-green-50 hover:bg-green-100 dark:text-green-400 dark:bg-green-950 dark:hover:bg-green-900 rounded-full transition-colors flex-shrink-0"
                            >
                              View Profile
                            </Link>
                          )}
                        </div>

                        {(() => {
                          const post = notification.post
                          const postUrl = post && getNotificationUrl(notification)
                          return postUrl && post ? (
                            <Link
                              href={postUrl}
                              onClick={(e) => e.stopPropagation()}
                              className="mt-2 p-3 bg-gray-100 dark:bg-gray-900 rounded-lg block text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors line-clamp-3"
                            >
                              {post.content}
                            </Link>
                          ) : null
                        })()}
                      </div>
                    </div>
                  </div>

                  {!notification.read && (
                    <div data-testid="unread-badge" className="w-2 h-2 bg-yappr-500 rounded-full mt-2 flex-shrink-0" />
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      <RightSidebar />
    </div>
  )
}

export default withAuth(NotificationsPage)
