'use client'

import { motion } from 'framer-motion'
import {
  UserCircleIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { TopUser } from '@/hooks/use-homepage-data'
import { formatNumber } from '@/lib/utils'

interface TopUsersSectionProps {
  users: TopUser[]
  loading: boolean
  error: string | null
  onRetry?: () => void
}

function UserSkeleton() {
  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-950 rounded-xl">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          <div className="h-3 w-16 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
        </div>
        <div className="h-6 w-14 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    </div>
  )
}

function UserAvatar({ user }: { user: TopUser }) {
  // Generate a consistent color based on user ID
  const colors = [
    'bg-yappr-500',
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-orange-500',
    'bg-pink-500'
  ]
  const colorIndex = user.id.charCodeAt(0) % colors.length
  const bgColor = colors[colorIndex]

  const initials = user.displayName
    ? user.displayName.substring(0, 2).toUpperCase()
    : user.username.substring(0, 2).toUpperCase()

  return (
    <div className={`w-12 h-12 ${bgColor} rounded-full flex items-center justify-center text-white font-medium`}>
      {initials}
    </div>
  )
}

export function TopUsersSection({
  users,
  loading,
  error,
  onRetry
}: TopUsersSectionProps) {
  return (
    <section className="py-12">
      <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <UserCircleIcon className="h-6 w-6 text-yappr-500" />
        Top Contributors
      </h2>

      {error ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400 mb-4">{error}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <ArrowPathIcon className="h-4 w-4 mr-2" />
              Retry
            </Button>
          )}
        </div>
      ) : loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <UserSkeleton key={i} />
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">
            No users yet. Be the first to join!
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {users.map((user, index) => (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.05 }}
            >
              <Link
                href={`/profile/${user.id}`}
                className="block p-4 bg-gray-50 dark:bg-gray-950 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <UserAvatar user={user} />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                      {user.displayName}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                      @{user.username}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-yappr-500">
                      {formatNumber(user.postCount)}
                    </p>
                    <p className="text-xs text-gray-500">posts</p>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </section>
  )
}
