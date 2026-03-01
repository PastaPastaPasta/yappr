import { motion } from 'framer-motion'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { estimateReadingTime, extractText } from '@/lib/blog/content-utils'
import type { BlogPost } from '@/lib/types'

interface BlogPostWithAuthor extends BlogPost {
  authorUsername?: string
  authorDisplayName?: string
  blogName?: string
}

interface BlogPostCardProps {
  post: BlogPostWithAuthor
  onClick: (post: BlogPostWithAuthor) => void
  index?: number
  className?: string
}

export function BlogPostCard({ post, onClick, index = 0, className = '' }: BlogPostCardProps) {
  const isDisabled = !post.authorUsername || !post.slug
  const rawExcerpt = extractText(post.content).replace(/\s+/g, ' ').trim()
  const excerpt = rawExcerpt && !post.subtitle ? (rawExcerpt.length > 150 ? `${rawExcerpt.slice(0, 150)}...` : rawExcerpt) : ''

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={index >= 0 ? { delay: index * 0.05 } : undefined}
      onClick={() => {
        if (isDisabled) return
        onClick(post)
      }}
      disabled={isDisabled}
      className={`w-full p-4 text-left ${className} ${
        isDisabled
          ? 'opacity-60 cursor-not-allowed'
          : 'hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors'
      }`}
    >
      <div className="flex gap-3">
        {post.coverImage && (
          <IpfsImage
            src={post.coverImage}
            alt={post.title}
            className="h-20 w-20 rounded-lg object-cover flex-shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            {post.blogName && (
              <span className="font-medium text-yappr-600 dark:text-yappr-400">{post.blogName}</span>
            )}
            {post.blogName && post.authorDisplayName && <span>·</span>}
            {post.authorDisplayName && <span>{post.authorDisplayName}</span>}
            {(post.blogName || post.authorDisplayName) && <span>·</span>}
            <span>{post.createdAt.toLocaleDateString()}</span>
            <span>·</span>
            <span>{estimateReadingTime(post.content)} min read</span>
          </div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-1">
            {post.title || 'Untitled'}
          </p>
          {post.subtitle && (
            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-1 mt-0.5">
              {post.subtitle}
            </p>
          )}
          {excerpt && (
            <p className="text-sm text-gray-500 line-clamp-2 mt-0.5">
              {excerpt}
            </p>
          )}
          {post.labels && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {Array.from(new Set(post.labels.split(',').map(l => l.trim()).filter(Boolean))).slice(0, 3).map((label, i) => (
                <span
                  key={`${label}-${i}`}
                  className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-yappr-100 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300 rounded"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.button>
  )
}
