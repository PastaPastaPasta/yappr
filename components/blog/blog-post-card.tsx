import { IpfsImage } from '@/components/ui/ipfs-image'
import { blogPostDate, estimateReadingTime, getPostExcerpt } from '@/lib/blog/content-utils'
import type { BlogPostWithAuthor } from '@/lib/types'

interface BlogPostCardProps {
  post: BlogPostWithAuthor
  onClick: (post: BlogPostWithAuthor) => void
  className?: string
}

/** Loading rows shaped like {@link BlogPostCard} (cover, meta line, title, two-line excerpt). */
export function BlogPostCardSkeleton({ count = 4 }: { count?: number }) {
  const bar = 'rounded bg-gray-200 dark:bg-gray-800 animate-pulse'
  return (
    <div className="divide-y divide-gray-200 dark:divide-gray-800" aria-busy="true" aria-label="Loading posts">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-3 p-4">
          <div className={`h-20 w-20 shrink-0 rounded-lg ${bar}`} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex h-4 items-center"><div className={`h-3 w-2/5 ${bar}`} /></div>
            <div className="flex h-5 items-center"><div className={`h-3.5 w-3/5 ${bar}`} /></div>
            <div className="mt-0.5 flex h-5 items-center"><div className={`h-3 w-full ${bar}`} /></div>
            <div className="flex h-5 items-center"><div className={`h-3 w-4/5 ${bar}`} /></div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function BlogPostCard({ post, onClick, className = '' }: BlogPostCardProps) {
  const isDisabled = !post.authorUsername || !post.slug
  const excerpt = getPostExcerpt(post, 150)

  return (
    <button
      type="button"
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
            <span>{blogPostDate(post).toLocaleDateString()}</span>
            <span>·</span>
            <span>{estimateReadingTime(post.content)} min read</span>
          </div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-1">
            {post.title || 'Untitled'}
          </p>
          {excerpt && (
            <p className="text-sm text-gray-500 line-clamp-2 mt-0.5">
              {excerpt}
            </p>
          )}
          {post.labels && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {post.labels.slice(0, 3).map((label, i) => (
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
    </button>
  )
}
