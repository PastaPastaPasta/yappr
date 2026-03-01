'use client'

import Link from 'next/link'
import type { Post } from '@/lib/types'
import { cn } from '@/lib/utils'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { extractText, getBlogPostUrl } from '@/lib/blog/content-utils'

export type EmbeddedBlogPostLike = Post

interface EmbeddedBlogPostCardProps {
  post: EmbeddedBlogPostLike
  className?: string
}

function toExcerpt(post: EmbeddedBlogPostLike): string {
  const raw = extractText(post.blogContent ?? post.content).replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.length > 150 ? `${raw.slice(0, 150)}...` : raw
}

export function isEmbeddedBlogPostLike(post: Post): post is EmbeddedBlogPostLike {
  return Boolean(
    post.__isBlogPostQuote ||
    (post.blogId && post.slug && post.title)
  )
}

export function EmbeddedBlogPostCard({ post, className = '' }: EmbeddedBlogPostCardProps) {
  const username = post.blogUsername || post.author.username
  const href = post.blogId && post.slug
    ? getBlogPostUrl(post.blogId, post.slug)
    : '#'
  const excerpt = toExcerpt(post)
  const blogLabel = post.blogName || post.author.displayName
  const subtitle = post.subtitle || (excerpt !== post.title ? excerpt : '')

  return (
    <Link
      href={href}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'mt-3 flex overflow-hidden rounded-xl border border-gray-700/80 hover:border-yappr-500/60 bg-gray-900/40 hover:bg-gray-900/60 transition-all group',
        className
      )}
    >
      {/* Left accent */}
      <div className="w-1 flex-shrink-0 bg-yappr-500/70 group-hover:bg-yappr-400 transition-colors" />

      <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
        {/* Cover image thumbnail */}
        {post.coverImage && (
          <IpfsImage
            src={post.coverImage}
            alt={post.title || 'Blog post cover'}
            className="h-14 w-14 flex-shrink-0 rounded-lg object-cover"
          />
        )}

        <div className="min-w-0 flex-1">
          {/* Source line */}
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-yappr-400 flex-shrink-0">
              <path d="M10.75 16.82A7.462 7.462 0 0 1 15 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0 0 18 15.06V3.44a.75.75 0 0 0-.546-.721A9.006 9.006 0 0 0 15 2.5a9.006 9.006 0 0 0-4.25 1.065v13.254ZM9.25 4.565A9.006 9.006 0 0 0 5 3.5a9.006 9.006 0 0 0-2.454.218A.75.75 0 0 0 2 4.44v11.62a.75.75 0 0 0 .954.721A7.506 7.506 0 0 1 5 16.5c1.579 0 3.042.487 4.25 1.32V4.565Z" />
            </svg>
            {blogLabel && <span className="truncate">{blogLabel}</span>}
            {blogLabel && username && <span>·</span>}
            {username && <span className="truncate">@{username}</span>}
          </div>

          {/* Title */}
          <p className="mt-0.5 line-clamp-1 text-sm font-semibold text-gray-100 group-hover:text-yappr-300 transition-colors">
            {post.title || 'Untitled'}
          </p>

          {/* Subtitle / excerpt — single line */}
          {subtitle && (
            <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}
