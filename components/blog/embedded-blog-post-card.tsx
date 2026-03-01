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
  const excerpt = toExcerpt(post)
  const blogLabel = post.blogName || post.author.displayName

  return (
    <Link
      href={href}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'mt-3 block overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 hover:border-yappr-400 dark:hover:border-yappr-600 transition-all group',
        className
      )}
    >
      {/* Cover image banner */}
      {post.coverImage ? (
        <div className="relative h-32 w-full bg-gray-100 dark:bg-gray-800">
          <IpfsImage
            src={post.coverImage}
            alt={post.title || 'Blog post cover'}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-2 py-0.5 text-[11px] font-medium text-white">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
              <path d="M3 4.75a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6.5ZM4.25 5a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-7.5ZM4 7.75A.25.25 0 0 1 4.25 7.5h7.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-7.5A.25.25 0 0 1 4 8.25v-.5ZM4.25 10a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h4.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-4.5Z" />
            </svg>
            Blog
          </span>
        </div>
      ) : null}

      <div className="p-3">
        {/* Blog badge when no cover image */}
        {!post.coverImage && (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-yappr-500 dark:text-yappr-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M3 4.75a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6.5ZM4.25 5a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-7.5ZM4 7.75A.25.25 0 0 1 4.25 7.5h7.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-7.5A.25.25 0 0 1 4 8.25v-.5ZM4.25 10a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h4.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-4.5Z" />
            </svg>
            Blog Post
          </div>
        )}

        {/* Title */}
        <p className="line-clamp-2 text-[15px] font-bold text-gray-900 dark:text-gray-100 group-hover:text-yappr-600 dark:group-hover:text-yappr-400 transition-colors">
          {post.title || 'Untitled'}
        </p>

        {/* Excerpt */}
        {excerpt && (
          <p className="mt-1 text-sm leading-snug text-gray-500 dark:text-gray-400 line-clamp-2">
            {excerpt}
          </p>
        )}

        {/* Footer: blog name + username */}
        <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-500">
          {blogLabel && <span className="font-medium text-gray-600 dark:text-gray-400">{blogLabel}</span>}
          {blogLabel && username && <span>·</span>}
          {username && <span>@{username}</span>}
        </div>
      </div>
    </Link>
  )
}
