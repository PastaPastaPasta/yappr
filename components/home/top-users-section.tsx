'use client'

import { motion } from 'framer-motion'
import {
  UserCircleIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/avatar-image'
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
    <div className="p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl border border-zinc-200/50 dark:border-zinc-800/30">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 bg-zinc-200 dark:bg-zinc-800 rounded-full animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-24 bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse" />
          <div className="h-3 w-16 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg animate-pulse" />
        </div>
        <div className="h-6 w-14 bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse" />
      </div>
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
      <h2 className="text-xl font-bold mb-5 flex items-center gap-2 tracking-tight">
        <UserCircleIcon className="h-5 w-5 text-yappr-500" />
        Top Contributors
      </h2>

      {error ? (
        <div className="text-center py-8">
          <p className="text-zinc-500 dark:text-zinc-400 mb-4 text-sm">{error}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <ArrowPathIcon className="h-4 w-4 mr-2" />
              Retry
            </Button>
          )}
        </div>
      ) : loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(3)].map((_, i) => (
            <UserSkeleton key={i} />
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-zinc-500 dark:text-zinc-400 text-sm">
            No users yet. Be the first to join!
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {users.map((user, index) => (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.05 }}
            >
              <Link
                href={`/user?id=${user.id}`}
                className="block p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-all duration-200 border border-zinc-200/50 dark:border-zinc-800/30"
              >
                <div className="flex items-center gap-3">
                  <UserAvatar userId={user.id} size="lg" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-zinc-900 dark:text-zinc-100 truncate text-sm">
                      {user.displayName}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      @{user.username}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-yappr-600 dark:text-yappr-400">
                      {formatNumber(user.postCount)}
                    </p>
                    <p className="text-2xs text-zinc-500">posts</p>
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
