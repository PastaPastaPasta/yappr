'use client'

import Link from 'next/link'
import type { Post } from '@/lib/types'
import { cn } from '@/lib/utils'
import { IpfsImage } from '@/components/ui/ipfs-image'

export interface EmbeddedBlogPostLike extends Post {
  __isBlogPostQuote?: boolean
  title?: string
  subtitle?: string
  slug?: string
  coverImage?: string
  blogName?: string
  blogUsername?: string
  blogContent?: unknown
}

interface EmbeddedBlogPostCardProps {
  post: EmbeddedBlogPostLike
  className?: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join(' ')
  }
  if (content && typeof content === 'object') {
    return Object.values(content as Record<string, unknown>)
      .map((item) => extractText(item))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function toExcerpt(post: EmbeddedBlogPostLike): string {
  const raw = extractText(post.blogContent ?? post.content).replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.length > 150 ? `${raw.slice(0, 150)}...` : raw
}

export function isEmbeddedBlogPostLike(post: Post): post is EmbeddedBlogPostLike {
  return Boolean((post as EmbeddedBlogPostLike).__isBlogPostQuote || (post as EmbeddedBlogPostLike).title)
}

export function EmbeddedBlogPostCard({ post, className = '' }: EmbeddedBlogPostCardProps) {
  const username = post.blogUsername || post.author.username
  const href = username && post.slug
    ? `/blog?user=${encodeURIComponent(username)}&post=${encodeURIComponent(post.slug)}`
    : '#'

  return (
    <Link
      href={href}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'mt-3 block border border-gray-200 dark:border-gray-700 rounded-xl p-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 hover:border-gray-400 dark:hover:border-gray-500 transition-all',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
        <span className="font-medium">{post.author.displayName}</span>
        <span className="inline-flex items-center rounded-full border border-yappr-200 dark:border-yappr-700 px-2 py-0.5 text-[11px] font-semibold text-yappr-600 dark:text-yappr-300">
          Blog Post
        </span>
      </div>
      <div className="mt-2 flex gap-3">
        {post.coverImage && (
          <IpfsImage
            src={post.coverImage}
            alt={post.title || 'Blog post cover'}
            className="h-20 w-20 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {post.title || 'Untitled'}
          </p>
          {toExcerpt(post) && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
              {toExcerpt(post)}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}
