'use client'

import Link from 'next/link'
import type { Post } from '@/lib/types'
import { cn } from '@/lib/utils'
import { IpfsImage } from '@/components/ui/ipfs-image'

export type EmbeddedBlogPostLike = Post

interface EmbeddedBlogPostCardProps {
  post: EmbeddedBlogPostLike
  className?: string
}

/** Extract human-readable text from BlockNote block structures. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''

      const b = block as {
        content?: unknown[]
        children?: unknown[]
        text?: string
        props?: Record<string, unknown>
      }

      // Inline content item (e.g. { type: "text", text: "Hello" })
      if (typeof b.text === 'string') return b.text

      const parts: string[] = []

      // Extract text from inline content array
      if (Array.isArray(b.content)) {
        for (const item of b.content) {
          if (typeof item === 'string') {
            parts.push(item)
          } else if (item && typeof item === 'object') {
            const maybeText = (item as { text?: unknown }).text
            if (typeof maybeText === 'string') parts.push(maybeText)
          }
        }
      }

      // Code blocks store text in props.code
      if (typeof b.props?.code === 'string' && b.props.code) {
        parts.push(b.props.code)
      }

      // Recurse into children blocks
      if (Array.isArray(b.children) && b.children.length > 0) {
        const childText = extractText(b.children)
        if (childText) parts.push(childText)
      }

      return parts.join(' ')
    })
    .filter(Boolean)
    .join(' ')
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
  const href = username && post.slug
    ? `/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(post.blogId || '')}&post=${encodeURIComponent(post.slug)}`
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
