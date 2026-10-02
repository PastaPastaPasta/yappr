'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { PostCard } from '@/components/post/post-card'
import { PostTips } from '@/components/post/post-tips'
import { ReplyThreadItem, flattenReplyThreads } from '@/components/post/reply-thread'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePostDetail } from '@/hooks/use-post-detail'
import { useAppStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { replyToPost } from '@/lib/services/post-service'
import type { Post } from '@/lib/types'
import { RemovedPostStub } from '@/components/moderation/removed-post-stub'
import { referencesMayDangle } from '@/lib/contract-topology'
import { isHiddenTombstone } from '@/lib/feed/hidden-tombstones'

function PostDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const postId = searchParams.get('id')
  const { user } = useAuth()
  const { setReplyingTo, setComposeOpen } = useAppStore()
  const openLoginModal = useLoginModal((s) => s.open)

  // All post loading and enrichment handled by hook
  // Uses cached post data for instant navigation when available
  const {
    post,
    replyThreads,
    replyChain,
    removedChainIds,
    replyRootPending,
    isLoading,
    isLoadingReplies,
    hasMoreReplies,
    isLoadingMoreReplies,
    loadMoreReplies,
    postEnrichment
  } = usePostDetail({
    postId,
    enabled: !!postId
  })

  const {
    sentinelRef: repliesSentinelRef,
    isSuspended: repliesAutoLoadSuspended,
    loadMore: loadMoreRepliesManually
  } = useInfiniteScroll({
    hasMore: hasMoreReplies,
    isLoading: isLoadingReplies || isLoadingMoreReplies,
    onLoadMore: loadMoreReplies,
    resetKey: postId
  })

  const {
    enrichProgressively: enrichRepliesProgressively,
    getPostEnrichment: getReplyEnrichment,
    reset: resetReplyEnrichment
  } = useProgressiveEnrichment({ currentUserId: user?.identityId })

  // The thread ROOT's author. Encryption is inherited from the root, so that is
  // whose feed keys decrypt anything in this thread and who grants access to it —
  // which is not the same identity when the item being viewed is a reply by
  // someone else. replyChain[0] is the root (v9) or the oldest known ancestor (v2).
  const rootPostOwnerId = (replyChain[0] ?? post)?.author.id ?? ''
  const { canReply: canReplyToPrivate, isLoading: isCheckingAccess, reason: cantReplyReason } = useCanReplyToPrivate(post, rootPostOwnerId)

  // The owner can delete the main post from its card; the fetched `post` does
  // not change until a reload, so remember it here to retire the reply prompt.
  const [deletedPostId, setDeletedPostId] = useState<string | null>(null)
  const isDeleted = Boolean(post?.deleted) || (!!post && post.id === deletedPostId)
  // Every reply names its thread's root, and consensus refuses one whose root
  // was removed (40120, paid: by moderators, or on v10 by its author), so
  // nothing on this page can be replied to.
  const threadRootRemoved = removedChainIds.length > 0
  // Until the root has been looked up (a cached reply shows first, and a failed
  // load never looks it up), whether it was removed is unknown, so nothing is
  // offered yet either.
  const replyBlockedReason = threadRootRemoved
    ? 'The post that started this thread was removed, so nothing in it can be replied to.'
    : replyRootPending ? 'Replies open once this thread has been checked. Reload the page if this stays.' : undefined

  useEffect(() => {
    resetReplyEnrichment()
  }, [postId, resetReplyEnrichment])

  // Notifications about a reply link to the whole thread with the reply as
  // `?reply=`, because a reply is only ever rendered inside its root's thread —
  // which on a flat topology can be fifty cards long. Scroll to it once the
  // thread has rendered. A reply on a not-yet-loaded page simply does not move
  // the viewport.
  const highlightReplyId = searchParams.get('reply')
  useEffect(() => {
    if (!highlightReplyId || replyThreads.length === 0) return
    document
      .querySelector(`[data-testid="post-card-${highlightReplyId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightReplyId, replyThreads])

  useEffect(() => {
    if (replyThreads.length === 0) return

    // Replies rendered as Post shapes: tagged as `reply` so their enrichment
    // queries resolve against the reply interaction doctypes. Walks every
    // rendered nesting level.
    const replyMap = new Map<string, Post>(
      // A deleted-parent stub is no document, and a v11 tombstone renders as a
      // stub with no counts, so neither has anything to enrich.
      flattenReplyThreads(replyThreads).filter((thread) => !thread.content.deletedStub && !isHiddenTombstone(thread.content)).map((thread): [string, Post] => [
        thread.content.id,
        replyToPost(thread.content)
      ])
    )

    const repliesToEnrich = Array.from(replyMap.values())
    enrichRepliesProgressively(repliesToEnrich)
  }, [replyThreads, enrichRepliesProgressively])

  const handleReply = () => {
    if (!post || isDeleted || replyBlockedReason || !canReplyToPrivate) return
    setReplyingTo(post)
    setComposeOpen(true)
  }

  if (!postId) {
    return (
      <PageShell>
            <div className="p-8 text-center text-gray-500">
              <p>Post not found</p>
            </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
        <PageHeader>
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              aria-label="Back"
              onClick={() => router.back()}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-bold">Post</h1>
          </div>
        </PageHeader>

        {isLoading && !post ? (
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading post...</p>
          </div>
        ) : post ? (
          <>
            {/* A thread root the contract's moderators removed (v9): the
                reply still exists, its parent does not. */}
            {removedChainIds.map((id) => (
              <RemovedPostStub key={id} documentId={id} kind="post" variant="card" />
            ))}
            {/* Reply chain - show predecessors leading up to this post */}
            {replyChain.length > 0 && (
              <div className="border-b border-gray-200 dark:border-gray-800">
                {replyChain.map((chainPost) => (
                  <div key={chainPost.id} className="relative">
                    {/* Thread line connecting to next item */}
                    <div
                      className="absolute left-[30px] top-[56px] bottom-0 w-0.5 bg-gray-300 dark:bg-gray-600"
                      aria-hidden="true"
                    />
                    <PostCard
                      post={chainPost}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Main post - the one being viewed */}
            <div className="border-b border-gray-200 dark:border-gray-800">
              <PostCard post={post} enrichment={postEnrichment} rootPostOwnerId={rootPostOwnerId} onDelete={setDeletedPostId} replyBlockedReason={replyBlockedReason} />
            </div>

            {/* Proved YAPP tips on this post — one token-history read, detail view only */}
            <PostTips postId={post.id} authorId={post.author.id} />

            {isDeleted ? (
              // Consensus accepts a reply to a v9 tombstone (v10 refuses one to a
              // deleted post, 40120); either way the post is gone for readers.
              <div className="p-4 border-b border-gray-200 dark:border-gray-800 text-center">
                <p className="text-gray-500 text-sm">This post was deleted, so it can&apos;t be replied to.</p>
              </div>
            ) : threadRootRemoved ? (
              <div className="p-4 border-b border-gray-200 dark:border-gray-800 text-center">
                <p className="text-gray-500 text-sm">{replyBlockedReason}</p>
              </div>
            ) : user ? (
              isCheckingAccess || replyRootPending ? (
                <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled
                  >
                    Checking access...
                  </Button>
                </div>
              ) : canReplyToPrivate ? (
                <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                  <Button
                    onClick={handleReply}
                    variant="outline"
                    className="w-full"
                  >
                    Post your reply
                  </Button>
                </div>
              ) : (
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 text-center">
                  <p className="text-gray-500 text-sm">
                    {cantReplyReason || "Can't reply to this post"}
                  </p>
                </div>
              )
            ) : (
              <div className="p-4 border-b border-gray-200 dark:border-gray-800 text-center">
                <p className="text-gray-500 text-sm">
                  <button onClick={openLoginModal} className="text-purple-600 hover:underline">Log in</button> to reply
                </p>
              </div>
            )}

            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {isLoadingReplies ? (
                <div className="p-6 text-center">
                  <Spinner size="sm" className="mx-auto mb-2" />
                  <p className="text-gray-500 text-sm">Loading replies...</p>
                </div>
              ) : replyThreads.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-gray-500">No replies yet. Be the first to reply!</p>
                </div>
              ) : (
                replyThreads.map((thread) => (
                  <ReplyThreadItem
                    key={thread.content.id}
                    thread={thread}
                    rootPostOwnerId={rootPostOwnerId}
                    getPostEnrichment={getReplyEnrichment}
                    replyBlockedReason={replyBlockedReason}
                  />
                ))
              )}

              {hasMoreReplies && (
                <InfiniteScrollSentinel
                  sentinelRef={repliesSentinelRef}
                  isLoading={isLoadingMoreReplies}
                  isSuspended={repliesAutoLoadSuspended}
                  onLoadMore={loadMoreRepliesManually}
                />
              )}
            </div>
          </>
        ) : referencesMayDangle() ? (
          // On a moderated contract an absent document may be a takedown: the
          // stub looks for a post OR reply removal record and only claims one
          // when it finds it; otherwise it says "unavailable".
          <RemovedPostStub documentId={postId} variant="card" />
        ) : (
          <div className="p-8 text-center">
            <p className="text-gray-500">Post not found</p>
          </div>
        )}
    </PageShell>
  )
}

function LoadingFallback() {
  return (
    <PageShell>
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading post...</p>
          </div>
    </PageShell>
  )
}

function PostDetailPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <PostDetailContent />
    </Suspense>
  )
}

export default withAuth(PostDetailPage, { optional: true })
