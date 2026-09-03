'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ReplyThreadItem, flattenReplyThreads } from '@/components/post/reply-thread'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePostDetail } from '@/hooks/use-post-detail'
import { useAppStore, useSettingsStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'
import { replyToPost } from '@/lib/services/post-service'
import type { Post } from '@/lib/types'

function PostDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const postId = searchParams.get('id')
  const { user } = useAuth()
  const { setReplyingTo, setComposeOpen } = useAppStore()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const openLoginModal = useLoginModal((s) => s.open)

  // All post loading and enrichment handled by hook
  // Uses cached post data for instant navigation when available
  const {
    post,
    replyThreads,
    replyChain,
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
  // someone else. replyChain[0] is the root (v3) or the oldest known ancestor (v2).
  const rootPostOwnerId = (replyChain[0] ?? post)?.author.id ?? ''
  const { canReply: canReplyToPrivate, isLoading: isCheckingAccess, reason: cantReplyReason } = useCanReplyToPrivate(post, rootPostOwnerId)

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
      flattenReplyThreads(replyThreads).map((thread): [string, Post] => [
        thread.content.id,
        replyToPost(thread.content)
      ])
    )

    const repliesToEnrich = Array.from(replyMap.values())
    enrichRepliesProgressively(repliesToEnrich)
  }, [replyThreads, enrichRepliesProgressively])

  const handleReply = () => {
    if (!post || !canReplyToPrivate) return
    setReplyingTo(post)
    setComposeOpen(true)
  }

  if (!postId) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
            <div className="p-8 text-center text-gray-500">
              <p>Post not found</p>
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              onClick={() => router.back()}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-bold">Post</h1>
          </div>
        </header>

        {isLoading && !post ? (
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading post...</p>
          </div>
        ) : post ? (
          <>
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
              <PostCard post={post} enrichment={postEnrichment} rootPostOwnerId={rootPostOwnerId} />
            </div>

            {user ? (
              isCheckingAccess ? (
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
        ) : (
          <div className="p-8 text-center">
            <p className="text-gray-500">Post not found</p>
          </div>
        )}
        </main>
      </div>

      <RightSidebar />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading post...</p>
          </div>
        </main>
      </div>
      <RightSidebar />
    </div>
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
