'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ReplyThreadItem } from '@/components/post/reply-thread'
import { ComposeModal } from '@/components/compose/compose-modal'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { usePostDetail } from '@/hooks/use-post-detail'
import { useAppStore, useSettingsStore } from '@/lib/store'
import { useCanReplyToPrivate } from '@/hooks/use-can-reply-to-private'

function PostDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const postId = searchParams.get('id')
  const { user } = useAuth()
  const { setReplyingTo, setComposeOpen } = useAppStore()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  // All post loading and enrichment handled by hook
  // Uses cached post data for instant navigation when available
  const {
    post,
    replyThreads,
    isLoading,
    isLoadingReplies,
    postEnrichment
  } = usePostDetail({
    postId,
    enabled: !!postId
  })

  // Check if user can reply to private posts
  // Posts are top-level content, so the feed owner is the post author
  const feedOwnerId = post?.author.id
  const { canReply: canReplyToPrivate, isLoading: isCheckingAccess, reason: cantReplyReason } = useCanReplyToPrivate(post, feedOwnerId)

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
        <header className={`sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
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
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading post...</p>
          </div>
        ) : post ? (
          <>
            <div className="border-b border-gray-200 dark:border-gray-800">
              <PostCard post={post} enrichment={postEnrichment} hideReplyTo />
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
                  <a href="/login" className="text-purple-600 hover:underline">Log in</a> to reply
                </p>
              </div>
            )}

            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {isLoadingReplies ? (
                <div className="p-6 text-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600 mx-auto mb-2"></div>
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
                    mainPostAuthorId={post.author.id}
                  />
                ))
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
      <ComposeModal />
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
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
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
