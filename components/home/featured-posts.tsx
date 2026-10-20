'use client'

import Link from 'next/link'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { Button } from '@/components/ui/button'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { PostCardSkeleton } from '@/components/post/post-card-skeleton'

interface FeaturedPostsProps {
  posts: Post[]
  loading: boolean
  error: string | null
  onRetry?: () => void
}

/** The most liked posts, topped up with the newest; readable without an account. */
export function FeaturedPosts({ posts, loading, error, onRetry }: FeaturedPostsProps) {
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const { user } = useAuth()
  const visible = filterHiddenSensitive(posts, sensitiveContentMode, user?.identityId)

  return (
    <section aria-labelledby="popular-posts-heading" className="min-w-0">
      <h2 id="popular-posts-heading" className="mb-4 text-xl font-bold">Popular posts</h2>

      {error ? (
        <div className="rounded-2xl border border-gray-200 py-10 text-center dark:border-gray-800">
          <p className="mb-4 text-gray-500 dark:text-gray-400">Couldn&apos;t load posts.</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <ArrowPathIcon className="mr-2 h-4 w-4" />
              Try again
            </Button>
          )}
        </div>
      ) : !loading && visible.length === 0 ? (
        <p className="rounded-2xl border border-gray-200 py-10 text-center text-gray-500 dark:border-gray-800 dark:text-gray-400">
          No posts yet.
        </p>
      ) : (
        <>
          {/* Full-bleed on phones, like a timeline; framed from `sm` up. The inner -mb-px tucks the last card's bottom border under the frame's. */}
          <div className="-mx-4 overflow-hidden border-y border-gray-200 dark:border-gray-800 sm:mx-0 sm:rounded-2xl sm:border">
            <div className="-mb-px">
              {loading
                ? [...Array(4)].map((_, i) => <PostCardSkeleton key={i} />)
                : visible.map((post) => <PostCard key={post.id} post={post} />)}
            </div>
          </div>
          {!loading && (
            <div className="mt-6 text-center">
              <Button variant="outline" asChild>
                <Link href="/feed">See more posts</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
