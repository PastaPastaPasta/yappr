'use client'

import Link from 'next/link'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { ReplyThread, Post } from '@/lib/types'
import { replyToPost } from '@/lib/services/post-service'
import { PostCard, ProgressiveEnrichment } from './post-card'

interface ReplyThreadItemProps {
  thread: ReplyThread
  rootPostOwnerId: string
  getPostEnrichment?: (post: Post) => ProgressiveEnrichment | undefined
}

/**
 * Depth-first, pre-order flatten of a nested reply subtree: each thread
 * followed by its whole subtree. Everything below a top-level reply renders at
 * one indent level — capping the indent keeps deep chains readable on narrow
 * screens while DFS order keeps each reply directly under its parent.
 */
export function flattenReplyThreads(threads: ReplyThread[]): ReplyThread[] {
  return threads.flatMap((thread) => [thread, ...flattenReplyThreads(thread.nestedReplies)])
}

/**
 * Renders a single reply thread item with optional thread line and nested replies.
 * - Author's thread posts show a connecting vertical line
 * - Nested replies are indented with a left border
 */
export function ReplyThreadItem({ thread, rootPostOwnerId, getPostEnrichment }: ReplyThreadItemProps) {
  const { content, isAuthorThread, isThreadContinuation, nestedReplies } = thread
  const postLike = replyToPost(content)

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
        rootPostOwnerId={rootPostOwnerId}
      />

      {/* Nested replies - flattened to a single indent level */}
      {nestedReplies.length > 0 && (
        <div className="ml-12 border-l-2 border-gray-200 dark:border-gray-700">
          {flattenReplyThreads(nestedReplies).map((nested) => (
            <NestedReply
              key={nested.content.id}
              thread={nested}
              rootPostOwnerId={rootPostOwnerId}
              getPostEnrichment={getPostEnrichment}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Renders a nested reply. The indentation and left border visually indicate
 * the reply hierarchy without explicit "Replying to" text.
 */
function NestedReply({ thread, rootPostOwnerId, getPostEnrichment }: ReplyThreadItemProps) {
  const postLike = replyToPost(thread.content)
  const enrichment = getPostEnrichment?.(postLike)

  // Replies past the depth cap: v3 counts them while assembling the (fully
  // loaded) thread, and that count stays valid even if children are later
  // nested optimistically. On v2 they were never fetched, so the enrichment
  // reply count is the only signal they exist — but it counts direct children,
  // so it only means "hidden" when none of them rendered.
  const hiddenCount = Math.max(
    thread.hiddenReplyCount ?? 0,
    thread.nestedReplies.length > 0 ? 0 : enrichment?.stats?.replies ?? 0
  )

  return (
    <div className="relative">
      <PostCard
        post={postLike}
        enrichment={enrichment}
        rootPostOwnerId={rootPostOwnerId}
      />

      {/* Continuation affordance: refocuses the page on this reply, showing its
          ancestors above and its full subtree below */}
      {hiddenCount > 0 && (
        <div className="relative">
          <span
            className="absolute left-[30px] top-0 h-3 w-0.5 bg-gray-300 dark:bg-gray-600"
            aria-hidden="true"
          />
          <Link
            href={`/post?id=${thread.content.id}`}
            className="group flex items-center gap-1.5 px-4 py-3 pl-16 text-sm font-medium text-yappr-500 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
          >
            <span>Continue thread</span>
            <span className="font-normal text-gray-500 dark:text-gray-400">
              · {hiddenCount} more {hiddenCount === 1 ? 'reply' : 'replies'}
            </span>
            <ChevronRightIcon
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      )}
    </div>
  )
}
