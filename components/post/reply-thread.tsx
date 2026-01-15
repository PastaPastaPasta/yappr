'use client'

import Link from 'next/link'
import { ReplyThread, Post } from '@/lib/types'
import { PostCard } from './post-card'

/**
 * Get the display identifier for a post author.
 * Priority: DPNS username > Profile display name > Truncated identity ID
 */
function getDisplayUsername(author: Post['author']): { display: string; type: 'dpns' | 'profile' | 'id' } {
  const hasDpns = (author as { hasDpns?: boolean }).hasDpns
  const username = author.username
  const displayName = author.displayName

  // If we have a confirmed DPNS name, use it
  if (hasDpns && username && !username.startsWith('user_')) {
    return { display: `@${username}`, type: 'dpns' }
  }

  // If we have a profile display name (not a placeholder), use it
  if (displayName && displayName !== 'Unknown User' && !displayName.startsWith('User ')) {
    return { display: displayName, type: 'profile' }
  }

  // Otherwise show truncated identity ID
  return {
    display: `${author.id.slice(0, 8)}...${author.id.slice(-6)}`,
    type: 'id'
  }
}

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

      <PostCard post={post} />

      {/* Nested replies (2nd level) - indented */}
      {nestedReplies.length > 0 && (
        <div className="ml-12 border-l-2 border-gray-200 dark:border-gray-700">
          {nestedReplies.map((nested) => (
            <NestedReply
              key={nested.post.id}
              reply={nested}
              parentPost={post}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface NestedReplyProps {
  reply: ReplyThread
  parentPost: Post
}

/**
 * Renders a nested (2nd level) reply with context about who it's replying to.
 */
function NestedReply({ reply, parentPost }: NestedReplyProps) {
  const { post } = reply
  const parentAuthorDisplay = getDisplayUsername(parentPost.author)

  // Style based on display type: DPNS gets blue, profile gets normal, ID gets monospace
  const linkClassName = parentAuthorDisplay.type === 'dpns'
    ? 'text-yappr-500 hover:underline'
    : parentAuthorDisplay.type === 'id'
      ? 'text-gray-500 font-mono text-xs hover:underline'
      : 'text-yappr-500 hover:underline'  // Profile gets same style as DPNS

  return (
    <div className="relative">
      {/* Context: who this is replying to */}
      <div className="px-4 pt-2 pb-0">
        <span className="text-sm text-gray-500">
          Replying to{' '}
          <Link
            href={`/user?id=${parentPost.author.id}`}
            className={linkClassName}
            onClick={(e) => e.stopPropagation()}
          >
            {parentAuthorDisplay.display}
          </Link>
        </span>
      </div>

      <PostCard post={post} />

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
