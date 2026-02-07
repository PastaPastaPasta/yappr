'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, AtSymbolIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { mentionService } from '@/lib/services/mention-service'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { dpnsService } from '@/lib/services/dpns-service'
import { useSettingsStore } from '@/lib/store'

function MentionsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('user')
  const { user: currentUser } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [mentionCount, setMentionCount] = useState(0)
  const [displayUsername, setDisplayUsername] = useState<string | null>(null)

  // Default to current user if no user specified
  const targetUserId = userId || currentUser?.identityId

  // Resolve username for display
  useEffect(() => {
    if (targetUserId) {
      dpnsService.resolveUsername(targetUserId)
        .then(username => setDisplayUsername(username))
        .catch(() => setDisplayUsername(null))
    }
  }, [targetUserId])

  useEffect(() => {
    const loadMentionedPosts = async () => {
      if (!targetUserId) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        // Get mention documents for this user
        const mentionDocs = await mentionService.getPostsMentioningUser(targetUserId)
        setMentionCount(mentionDocs.length)

        if (mentionDocs.length === 0) {
          setPosts([])
          setIsLoading(false)
          return
        }

        // Fetch the actual posts using postService
        const { postService } = await import('@/lib/services/post-service')

        const postIds = Array.from(new Set(mentionDocs.map(m => m.postId)))

        // Fetch posts and validate ownership
        const fetchedPosts: Post[] = []
        for (const postId of postIds) {
          try {
            const post = await postService.get(postId)
            if (post) {
              // Verify mention was created by post owner (security filter)
              const mentionDoc = mentionDocs.find(m => m.postId === postId)
              if (mentionDoc && mentionDoc.$ownerId === post.author.id) {
                fetchedPosts.push(post)
              }
            }
          } catch (error) {
            console.error('Failed to fetch post:', postId, error)
          }
        }

        // Sort by creation date (newest first)
        fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

        // Enrich posts with author data (DPNS names, displayNames, stats)
        let enrichedPosts = await postService.enrichPostsBatch(fetchedPosts)

        // Filter out posts from blocked users
        if (currentUser?.identityId && enrichedPosts.length > 0) {
          const authorIds = Array.from(new Set(enrichedPosts.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(currentUser.identityId, authorIds)
          enrichedPosts = enrichedPosts.filter(post => !blockedMap.get(post.author.id))
        }

        setPosts(enrichedPosts)
        setMentionCount(enrichedPosts.length)
      } catch (error) {
        console.error('Failed to load mentioned posts:', error)
        setPosts([])
      } finally {
        setIsLoading(false)
      }
    }

    loadMentionedPosts().catch(err => console.error('Failed to load mentioned posts:', err))
  }, [targetUserId, currentUser?.identityId])

  // If not logged in and no user specified
  if (!targetUserId) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-surface-200 dark:border-surface-800">
            <div className="p-12 text-center">
              <AtSymbolIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">No user specified</h2>
              <p className="text-gray-500">
                Log in to see posts that mention you
              </p>
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
    )
  }

  const isCurrentUser = currentUser?.identityId === targetUserId
  const headerTitle = isCurrentUser
    ? 'Mentions'
    : displayUsername
      ? `Mentions of @${displayUsername}`
      : 'Mentions'

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-surface-200 dark:border-surface-800">
          {/* Header */}
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-surface-950/70 border-b border-surface-200 dark:border-surface-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-display font-bold flex items-center gap-1">
                  <AtSymbolIcon className="h-5 w-5 text-yappr-500" />
                  {headerTitle}
                </h1>
                <p className="text-sm text-gray-500">
                  {formatNumber(mentionCount)} {mentionCount === 1 ? 'post' : 'posts'}
                </p>
              </div>
            </div>
          </header>

          {/* Content */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {isLoading ? (
              <div className="p-8 text-center">
                <Spinner size="md" className="mx-auto mb-4" />
                <p className="text-gray-500">Loading mentions...</p>
              </div>
            ) : posts.length === 0 ? (
              <div className="p-12 text-center">
                <AtSymbolIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">No mentions yet</h2>
                <p className="text-gray-500 mb-4">
                  {isCurrentUser
                    ? 'When people mention you in their posts, they will appear here'
                    : `No posts mentioning this user yet`
                  }
                </p>
              </div>
            ) : (
              posts.map((post, index) => (
                <motion.div
                  key={post.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <PostCard post={post} />
                </motion.div>
              ))
            )}
          </div>
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}

export default function MentionsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <MentionsPageContent />
    </Suspense>
  )
}
