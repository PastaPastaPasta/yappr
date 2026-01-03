'use client'

import { motion } from 'framer-motion'
import {
  SparklesIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { Button } from '@/components/ui/button'
import { Post } from '@/lib/types'
import Link from 'next/link'

interface FeaturedPostsProps {
  posts: Post[]
  loading: boolean
  error: string | null
  onRetry?: () => void
}

function PostSkeleton() {
  return (
    <div className="bg-white dark:bg-black rounded-xl border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          <div className="space-y-2">
            <div className="h-4 w-full bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
            <div className="h-4 w-3/4 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
          </div>
          <div className="flex gap-6 pt-2">
            <div className="h-4 w-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-10 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function FeaturedPosts({
  posts,
  loading,
  error,
  onRetry
}: FeaturedPostsProps) {
  return (
    <section className="py-12">
      <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <SparklesIcon className="h-6 w-6 text-yappr-500" />
        Popular Posts
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
        <div className="max-w-2xl mx-auto space-y-4">
          {[...Array(3)].map((_, i) => (
            <PostSkeleton key={i} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            No posts yet. Be the first to share something!
          </p>
          <Button asChild>
            <Link href="/login">Get Started</Link>
          </Button>
        </div>
      ) : (
        <div className="max-w-2xl mx-auto space-y-4">
          {posts.map((post, index) => (
            <motion.div
              key={post.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="bg-white dark:bg-black rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden"
            >
              <PostCard post={post} />
            </motion.div>
          ))}

          <div className="text-center pt-8">
            <Button variant="outline" asChild>
              <Link href="/login">Sign in to see more</Link>
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
