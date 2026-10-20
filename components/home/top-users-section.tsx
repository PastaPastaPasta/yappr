'use client'

import { useId } from 'react'
import Link from 'next/link'
import { UserAvatar } from '@/components/ui/avatar-image'
import { TopUser } from '@/hooks/use-homepage-data'
import { cn, formatNumber } from '@/lib/utils'

interface TopUsersSectionProps {
  users: TopUser[]
  loading: boolean
  error: string | null
  className?: string
}

const ROW = 'flex items-center gap-3 px-4 py-3'

function UserSkeleton() {
  return (
    <div className={ROW} aria-hidden="true">
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800" />
      <div className="flex-1 space-y-1.5">
        <div className="h-4 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-3.5 w-32 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
      </div>
    </div>
  )
}

/** The people with the most posts, as a compact "who to follow" list. Hidden when there is nothing to show. */
export function TopUsersSection({ users, loading, error, className }: TopUsersSectionProps) {
  // The landing page mounts one copy in the right rail and one under the posts; CSS shows one.
  const headingId = useId()
  if (error || (!loading && users.length === 0)) return null

  return (
    <section aria-labelledby={headingId} className={cn('overflow-hidden rounded-2xl bg-gray-50 dark:bg-gray-950', className)}>
      <h2 id={headingId} className="px-4 pb-1 pt-3 text-xl font-bold">Top contributors</h2>
      <ul>
        {loading
          ? [...Array(4)].map((_, i) => <li key={i}><UserSkeleton /></li>)
          : users.map((user) => (
            <li key={user.id}>
              <Link
                href={`/user?id=${user.id}`}
                className={`${ROW} transition-colors hover:bg-gray-100 dark:hover:bg-gray-900`}
              >
                <UserAvatar userId={user.id} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-gray-900 dark:text-gray-100">{user.displayName}</p>
                  <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                    {user.username ? `@${user.username} · ` : ''}
                    {formatNumber(user.postCount)} {user.postCount === 1 ? 'post' : 'posts'}
                  </p>
                </div>
              </Link>
            </li>
          ))}
      </ul>
    </section>
  )
}
