'use client'

import { motion } from 'framer-motion'
import {
  UserPlusIcon,
  BellIcon,
  Cog6ToothIcon,
  AtSymbolIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { withAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import Link from 'next/link'
import { useNotificationStore } from '@/lib/stores/notification-store'
import { Notification } from '@/lib/types'

type NotificationFilter = 'all' | 'follow' | 'mention'

const FILTER_TABS: { key: NotificationFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'follow', label: 'Follows' },
  { key: 'mention', label: 'Mentions' }
]

const NOTIFICATION_ICONS: Record<Notification['type'], JSX.Element> = {
  follow: <UserPlusIcon className="h-5 w-5 text-purple-500" />,
  mention: <AtSymbolIcon className="h-5 w-5 text-yellow-500" />
}

const NOTIFICATION_MESSAGES: Record<Notification['type'], string> = {
  follow: 'started following you',
  mention: 'mentioned you in a post'
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
  // Store - polling is handled by Sidebar, we just display data
  const filter = useNotificationStore((s) => s.filter)
  const isLoading = useNotificationStore((s) => s.isLoading)
  const setFilter = useNotificationStore((s) => s.setFilter)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead)
  const getFilteredNotifications = useNotificationStore((s) => s.getFilteredNotifications)
  const getUnreadCount = useNotificationStore((s) => s.getUnreadCount)

  const filteredNotifications = getFilteredNotifications()
  const unreadCount = getUnreadCount()

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between px-4 py-3">
            <h1 className="text-xl font-bold">Notifications</h1>
            <Link
              href="/settings"
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
            >
              <Cog6ToothIcon className="h-5 w-5" />
            </Link>
          </div>

          <div className="flex border-b border-gray-200 dark:border-gray-800">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`flex-1 py-4 text-sm font-medium transition-colors relative ${
                  filter === tab.key
                    ? 'text-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {tab.label}
                {filter === tab.key && (
                  <motion.div
                    layoutId="notificationTab"
                    className="absolute bottom-0 left-0 right-0 h-1 bg-yappr-500"
                  />
                )}
              </button>
            ))}
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

        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading notifications...</p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="p-8 text-center">
            <BellIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No notifications yet</p>
            <p className="text-sm text-gray-400 mt-2">
              When someone follows you or mentions you, you&apos;ll see it here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {filteredNotifications.map((notification) => (
              <motion.div
                key={notification.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={() => !notification.read && markAsRead(notification.id)}
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
                        <p className="text-sm">
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

                        {notification.post && (
                          <Link
                            href={`/post?id=${notification.post.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-2 p-3 bg-gray-100 dark:bg-gray-900 rounded-lg block text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors line-clamp-3"
                          >
                            {notification.post.content}
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>

                  {!notification.read && (
                    <div className="w-2 h-2 bg-yappr-500 rounded-full mt-2 flex-shrink-0" />
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
