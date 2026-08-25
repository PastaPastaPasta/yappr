'use client'

import Link from 'next/link'
import { ReplyThread, Reply, Post } from '@/lib/types'
import { PostCard, ProgressiveEnrichment } from './post-card'

/**
 * Convert a Reply to a Post-like object for PostCard rendering.
 * This is a temporary adapter until PostCard is updated to handle both types.
 * Preserves parentId/parentOwnerId so PostCard can detect replies for deletion.
 */
function replyToPostLike(reply: Reply): Post {
  return {
    id: reply.id,
    author: reply.author,
    content: reply.content,
    createdAt: reply.createdAt,
    likes: reply.likes,
    reposts: reply.reposts,
    replies: reply.replies,
    views: reply.views,
    liked: reply.liked,
    reposted: reply.reposted,
    bookmarked: reply.bookmarked,
    media: reply.media,
    _enrichment: reply._enrichment,
    encryptedContent: reply.encryptedContent,
    epoch: reply.epoch,
    nonce: reply.nonce,
    parentId: reply.parentId,
    parentOwnerId: reply.parentOwnerId,
  }
}

interface ReplyThreadItemProps {
  thread: ReplyThread
  mainPostAuthorId: string
  getPostEnrichment?: (post: Post) => ProgressiveEnrichment | undefined
}

/**
 * Renders a single reply thread item with optional thread line and nested replies.
 * - Author's thread posts show a connecting vertical line
 * - Nested replies are indented with a left border
 */
export function ReplyThreadItem({ thread, mainPostAuthorId, getPostEnrichment }: ReplyThreadItemProps) {
  const { content, isAuthorThread, isThreadContinuation, nestedReplies } = thread
  const postLike = replyToPostLike(content)

  return (
    <div className="relative">
      {/* Thread line connecting to previous author reply */}
      {isThreadContinuation && (
        <div
          className="absolute left-[30px] -top-[1px] w-0.5 h-4 bg-gray-300 dark:bg-gray-600"
          aria-hidden="true"
        />
      )}

      {/* Author thread indicator badge */}
      {isAuthorThread && !isThreadContinuation && (
        <div className="px-4 pt-2 pb-0">
          <div className="ml-[52px] text-xs text-yappr-500 font-medium flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-yappr-500 rounded-full" />
            Author thread
          </div>
        </div>
      )}

      <PostCard
        post={postLike}
        enrichment={getPostEnrichment?.(postLike)}
        rootPostOwnerId={mainPostAuthorId}
      />

      {/* Nested replies (2nd level) - indented */}
      {nestedReplies.length > 0 && (
        <div className="ml-12 border-l-2 border-gray-200 dark:border-gray-700">
          {nestedReplies.map((nested) => (
            <NestedReply
              key={nested.content.id}
              thread={nested}
              mainPostAuthorId={mainPostAuthorId}
              getPostEnrichment={getPostEnrichment}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface NestedReplyProps {
  thread: ReplyThread
  mainPostAuthorId: string
  getPostEnrichment?: (post: Post) => ProgressiveEnrichment | undefined
}

/**
 * Renders a nested (2nd level) reply. The indentation and left border
 * visually indicate the reply hierarchy without explicit "Replying to" text.
 */
function NestedReply({ thread, mainPostAuthorId, getPostEnrichment }: NestedReplyProps) {
  const { content } = thread
  const postLike = replyToPostLike(content)

  return (
    <div className="relative">
      <PostCard
        post={postLike}
        enrichment={getPostEnrichment?.(postLike)}
        rootPostOwnerId={mainPostAuthorId}
      />

      {/* Show "View more replies" if this reply has replies (3+ level) */}
      {content.replies > 0 && (
        <div className="px-4 pb-3 pl-16">
          <Link
            href={`/post?id=${content.id}`}
            className="text-sm text-yappr-500 hover:underline"
          >
            View {content.replies} more {content.replies === 1 ? 'reply' : 'replies'}
          </Link>
        </div>
      )}
    </div>
  )
}
