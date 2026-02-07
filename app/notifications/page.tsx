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
  ChatBubbleLeftIcon,
  ChevronDownIcon,
  FunnelIcon
} from '@heroicons/react/24/outline'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { UserAvatar } from '@/components/ui/avatar-image'
import { formatTimeCompact } from '@/lib/utils'
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

const FILTER_TABS: { key: NotificationFilter; label: string; icon: JSX.Element }[] = [
  { key: 'all', label: 'All', icon: <BellIcon className="h-4 w-4" /> },
  { key: 'like', label: 'Likes', icon: <HeartIcon className="h-4 w-4 text-red-500" /> },
  { key: 'repost', label: 'Reposts', icon: <ArrowPathRoundedSquareIcon className="h-4 w-4 text-green-500" /> },
  { key: 'reply', label: 'Replies', icon: <ChatBubbleLeftIcon className="h-4 w-4 text-blue-500" /> },
  { key: 'follow', label: 'Follows', icon: <UserPlusIcon className="h-4 w-4 text-yappr-500" /> },
  { key: 'mention', label: 'Mentions', icon: <AtSymbolIcon className="h-4 w-4 text-yellow-500" /> },
  { key: 'privateFeed', label: 'Private', icon: <LockClosedIcon className="h-4 w-4 text-blue-500" /> }
]

const NOTIFICATION_ICONS: Record<Notification['type'], JSX.Element> = {
  follow: <UserPlusIcon className="h-5 w-5 text-yappr-500" />,
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

      <div className="flex-1 flex justify-center min-w-0">
      <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="flex items-center justify-between px-4 py-3">
            <h1 className="text-xl font-bold">Notifications</h1>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={markAllAsRead}
                  className="text-yappr-500 hover:text-yappr-600 text-sm"
                >
                  Mark all as read
                </Button>
              )}
              {/* Mobile filter dropdown */}
              <div className="md:hidden">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-full bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      data-testid="notification-filter-dropdown"
                    >
                      <FunnelIcon className="h-4 w-4" />
                      <span>{FILTER_TABS.find(t => t.key === filter)?.label}</span>
                      {getUnreadCountForTab(filter) > 0 && (
                        <span className="w-2 h-2 bg-yappr-500 rounded-full" />
                      )}
                      <ChevronDownIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="min-w-[200px] bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50"
                      sideOffset={8}
                      align="end"
                    >
                      {FILTER_TABS.map((tab) => {
                        const tabUnreadCount = getUnreadCountForTab(tab.key)
                        return (
                          <DropdownMenu.Item
                            key={tab.key}
                            data-testid={`notification-filter-${tab.key}`}
                            onClick={() => setFilter(tab.key)}
                            className={`flex items-center justify-between px-4 py-3 text-sm cursor-pointer outline-none transition-colors ${
                              filter === tab.key
                                ? 'bg-yappr-50 dark:bg-yappr-950/30 text-yappr-600 dark:text-yappr-400'
                                : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                          >
                            <span className="flex items-center gap-3">
                              {tab.icon}
                              <span className="font-medium">{tab.label}</span>
                            </span>
                            {tabUnreadCount > 0 && (
                              <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold bg-yappr-500 text-white rounded-full">
                                {tabUnreadCount > 99 ? '99+' : tabUnreadCount}
                              </span>
                            )}
                          </DropdownMenu.Item>
                        )
                      })}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
              <Link
                href="/settings?section=notifications"
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
              >
                <Cog6ToothIcon className="h-5 w-5" />
              </Link>
            </div>
          </div>

          {/* Desktop tabs - hidden on mobile */}
          <div className="hidden md:flex border-b border-gray-200 dark:border-gray-800">
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

        {isLoading || !hasFetchedOnce ? (
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
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
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {NOTIFICATION_ICONS[notification.type] || <BellIcon className="h-5 w-5 text-gray-500" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/user?id=${notification.from?.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="h-10 w-10 rounded-full overflow-hidden bg-white dark:bg-gray-900 flex-shrink-0"
                      >
                        <UserAvatar userId={notification.from?.id || ''} size="md" alt="User avatar" />
                      </Link>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
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
                              {formatTimeCompact(notification.createdAt)}
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
                    <div data-testid="unread-badge" className="w-2 h-2 bg-yappr-500 rounded-full flex-shrink-0" />
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>
      </div>

      <RightSidebar />
    </div>
  )
}

export default withAuth(NotificationsPage)
