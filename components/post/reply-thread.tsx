'use client'

import Link from 'next/link'
import { ReplyThread } from '@/lib/types'
import { PostCard } from './post-card'

interface ReplyThreadItemProps {
  thread: ReplyThread
  mainPostAuthorId: string
}

/**
 * Renders a single reply thread item with optional thread line and nested replies.
 * - Author's thread posts show a connecting vertical line
 * - Nested replies are indented with a left border
 */
export function ReplyThreadItem({ thread }: ReplyThreadItemProps) {
  const { post, isAuthorThread, isThreadContinuation, nestedReplies } = thread

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

      <PostCard post={post} hideReplyTo />

      {/* Nested replies (2nd level) - indented */}
      {nestedReplies.length > 0 && (
        <div className="ml-12 border-l-2 border-gray-200 dark:border-gray-700">
          {nestedReplies.map((nested) => (
            <NestedReply
              key={nested.post.id}
              reply={nested}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface NestedReplyProps {
  reply: ReplyThread
}

/**
 * Renders a nested (2nd level) reply. The indentation and left border
 * visually indicate the reply hierarchy without explicit "Replying to" text.
 */
function NestedReply({ reply }: NestedReplyProps) {
  const { post } = reply

  return (
    <div className="relative">
      <PostCard post={post} hideReplyTo />

      {/* Show "View more replies" if this reply has replies (3+ level) */}
      {post.replies > 0 && (
        <div className="px-4 pb-3 pl-16">
          <Link
            href={`/post?id=${post.id}`}
            className="text-sm text-yappr-500 hover:underline"
          >
            View {post.replies} more {post.replies === 1 ? 'reply' : 'replies'}
          </Link>
        </div>
      )}
    </div>
  )
}
