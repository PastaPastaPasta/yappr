'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ReplyThreadItem } from '@/components/post/reply-thread'
import { ComposeModal } from '@/components/compose/compose-modal'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Post } from '@/lib/types'
import { getDashPlatformClient } from '@/lib/dash-platform-client'
import { usePostDetail } from '@/hooks/use-post-detail'
import toast from 'react-hot-toast'

function PostDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const postId = searchParams.get('id')
  const { user } = useAuth()

  const [replyContent, setReplyContent] = useState('')
  const [isReplying, setIsReplying] = useState(false)

  // All post loading and enrichment handled by hook
  // enrichmentPhase is destructured to trigger re-renders when enrichment data arrives
  const {
    post,
    parentPost,
    replyThreads,
    isLoading,
    addOptimisticReply,
    updatePost,
    getPostEnrichment,
    enrichmentPhase
  } = usePostDetail({
    postId,
    enabled: !!postId
  })

  const handleReply = async () => {
    if (!replyContent.trim() || !post || !user) return

    setIsReplying(true)
    try {
      const dashClient = getDashPlatformClient()
      await dashClient.createPost(replyContent, { replyToPostId: post.id })

      // Add optimistic reply
      const newReply: Post = {
        id: `reply_${Date.now()}`,
        content: replyContent,
        author: {
          id: user.identityId,
          username: user.identityId.slice(0, 8) + '...',
          displayName: user.identityId.slice(0, 8) + '...',
          avatar: '',
          followers: 0,
          following: 0,
          joinedAt: new Date()
        },
        createdAt: new Date(),
        likes: 0,
        replies: 0,
        reposts: 0,
        views: 0,
        replyToId: post.id
      }

      addOptimisticReply(newReply)
      setReplyContent('')
      toast.success('Reply posted!')
    } catch (error) {
      console.error('Failed to post reply:', error)
      toast.error('Failed to post reply')
    } finally {
      setIsReplying(false)
    }
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
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
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

        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading post...</p>
          </div>
        ) : post ? (
          <>
            {parentPost && (
              <div className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                <div className="px-4 pt-3 pb-1">
                  <span className="text-sm text-gray-500">Replying to:</span>
                </div>
                <PostCard post={parentPost} enrichment={getPostEnrichment(parentPost)} />
              </div>
            )}

            <div className="border-b border-gray-200 dark:border-gray-800">
              <PostCard post={post} enrichment={getPostEnrichment(post)} />
            </div>

            {user ? (
              <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleReply()
                  }}
                  className="space-y-3"
                >
                  <Input
                    type="text"
                    placeholder="Post your reply"
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault()
                        handleReply()
                      }
                    }}
                    className="w-full"
                    maxLength={500}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">
                      {replyContent.length}/500
                    </span>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!replyContent.trim() || isReplying}
                    >
                      {isReplying ? 'Posting...' : 'Reply'}
                    </Button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="p-4 border-b border-gray-200 dark:border-gray-800 text-center">
                <p className="text-gray-500 text-sm">
                  <a href="/login" className="text-purple-600 hover:underline">Log in</a> to reply
                </p>
              </div>
            )}

            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {replyThreads.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-gray-500">No replies yet. Be the first to reply!</p>
                </div>
              ) : (
                replyThreads.map((thread) => (
                  <ReplyThreadItem
                    key={thread.post.id}
                    thread={thread}
                    mainPostAuthorId={post.author.id}
                    getPostEnrichment={getPostEnrichment}
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
