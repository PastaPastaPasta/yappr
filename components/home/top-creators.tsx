'use client'

import Link from 'next/link'
import { UserAvatar } from '@/components/ui/avatar-image'
import { TopUser } from '@/hooks/use-homepage-data'
import { formatNumber } from '@/lib/utils'

interface TopCreatorsProps {
  users: TopUser[]
  loading: boolean
  error: string | null
}

// One chip shape for the real thing and its placeholder, so the section holds
// its height while loading. A row that scrolls sideways on a phone, a grid from `sm` up.
const LIST = 'flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-hide sm:grid sm:grid-cols-3 sm:gap-2 sm:overflow-visible'
const ITEM = 'shrink-0 sm:min-w-0 sm:shrink'
const CHIP = 'flex w-[200px] items-center gap-2 rounded-2xl border border-gray-200 py-2.5 pl-2 pr-1.5 dark:border-gray-800 sm:w-auto'
const SKELETON_COUNT = 6

/** The people with the most posts, as a row of chips. Hidden when there is nothing to show. */
export function TopCreators({ users, loading, error }: TopCreatorsProps) {
  if (error || (!loading && users.length === 0)) return null

  return (
    <section aria-labelledby="top-creators-heading" className="mb-10 min-w-0">
      <h2 id="top-creators-heading" className="mb-3 px-4 text-xl font-bold">Top creators</h2>
      <ul className={LIST}>
        {loading
          ? [...Array(SKELETON_COUNT)].map((_, i) => (
            <li key={i} className={ITEM} aria-hidden="true">
              <div className={CHIP}>
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
                  <div className="h-3 w-24 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
                </div>
              </div>
            </li>
          ))
          : users.map((user) => (
            <li key={user.id} className={ITEM}>
              <Link
                href={`/user?id=${user.id}`}
                className={`${CHIP} transition-colors hover:bg-gray-50 dark:hover:bg-gray-950`}
              >
                <UserAvatar userId={user.id} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold leading-5 text-gray-900 dark:text-gray-100">{user.displayName}</p>
                  <p className="truncate text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {user.username ? `@${user.username}` : `${formatNumber(user.postCount)} ${user.postCount === 1 ? 'post' : 'posts'}`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
      </ul>
    </section>
  )
}
