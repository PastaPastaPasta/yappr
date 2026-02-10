'use client'

import Link from 'next/link'
import type { Post } from '@/lib/types'
import { cn, formatTime } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/avatar-image'
import { PostContent } from './post-content'
import { PrivateQuotedPostContent, isQuotedPostPrivate } from './private-quoted-post-content'

export interface EmbeddedPostCardProps {
  post: Post
  className?: string
}

export interface EmbeddedPostSkeletonProps {
  className?: string
}

const EMBED_CONTAINER_CLASS = 'mt-3 block border border-gray-200 dark:border-gray-700 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 hover:border-gray-400 dark:hover:border-gray-500 transition-all cursor-pointer'

export function EmbeddedPostCard({ post, className = '' }: EmbeddedPostCardProps) {
  if (isQuotedPostPrivate(post)) {
    return <PrivateQuotedPostContent quotedPost={post} className={className} />
  }

  return (
    <Link
      href={`/post?id=${post.id}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(EMBED_CONTAINER_CLASS, className)}
    >
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <UserAvatar userId={post.author.id} size="sm" alt={post.author.displayName} />
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {post.author.displayName}
        </span>
        {post.author.username && !post.author.username.startsWith('user_') ? (
          <span className="text-gray-500">@{post.author.username}</span>
        ) : (
          <span className="text-gray-500 font-mono text-xs">
            {post.author.id.slice(0, 8)}...
          </span>
        )}
        <span>·</span>
        <span>{formatTime(post.createdAt)}</span>
      </div>
      <PostContent content={post.content} className="mt-1 text-sm" disableInternalPostEmbed />
    </Link>
  )
}

export function EmbeddedPostSkeleton({ className = '' }: EmbeddedPostSkeletonProps) {
  return (
    <div className={cn('mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3 animate-pulse', className)}>
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
      <div className="mt-2 space-y-2">
        <div className="h-3 w-full bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-3 w-3/4 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    </div>
  )
}
