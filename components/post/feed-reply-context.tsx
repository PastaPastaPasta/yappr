'use client'

import Link from 'next/link'
import { ChatBubbleLeftIcon } from '@heroicons/react/24/outline'
import { Post } from '@/lib/types'
import { PostCard, ProgressiveEnrichment } from './post-card'

interface FeedReplyContextProps {
  originalPost: Post
  reply: Post
  replier: {
    id: string
    username?: string
    displayName?: string
  }
  /** Enrichment data for the reply post */
  replyEnrichment?: ProgressiveEnrichment
  /** Enrichment data for the original post */
  originalPostEnrichment?: ProgressiveEnrichment
  isOwnPost?: boolean
  /** Callback when a post is deleted */
  onDelete?: (postId: string) => void
}

/**
 * Renders a reply context card for the Following feed.
 * Shows the original post that was replied to, with a header indicating who replied,
 * followed by the actual reply.
 */
export function FeedReplyContext({
  originalPost,
  reply,
  replier,
  replyEnrichment,
  originalPostEnrichment,
  isOwnPost,
  onDelete
}: FeedReplyContextProps) {
  // Use enriched username from DPNS if available, fall back to replier data
  const replierName = replyEnrichment?.username
    ? `@${replyEnrichment.username}`
    : replyEnrichment?.displayName || replier.displayName || `User ${replier.id.slice(-6)}`

  return (
    <div className="border-b border-border">
      {/* Header: Who replied */}
      <Link
        href={`/user?id=${replier.id}`}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-2 text-sm text-gray-500 px-4 pt-3 pb-1 hover:underline"
      >
        <ChatBubbleLeftIcon className="h-4 w-4" />
        <span>
          <span className="text-yappr-500 font-medium">{replierName}</span> replied
        </span>
      </Link>

      {/* Original post with muted background */}
      <div className="bg-gray-50 dark:bg-gray-950/50 border-l-2 border-gray-300 dark:border-gray-700 ml-4 mr-4 rounded-lg overflow-hidden">
        <PostCard
          post={originalPost}
          enrichment={originalPostEnrichment}
          onDelete={onDelete}
        />
      </div>

      {/* Visual connector */}
      <div className="flex items-center px-4 py-1">
        <div className="ml-[26px] w-0.5 h-4 bg-gray-300 dark:bg-gray-600" />
      </div>

      {/* The reply */}
      <PostCard
        post={reply}
        isOwnPost={isOwnPost}
        enrichment={replyEnrichment}
        hideReplyTo
        onDelete={onDelete}
      />
    </div>
  )
}
