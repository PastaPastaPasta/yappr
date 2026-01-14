'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, HashtagIcon, CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { formatNumber } from '@/lib/utils'
import { hashtagService } from '@/lib/services/hashtag-service'
import { HASHTAG_CONTRACT_ID } from '@/lib/constants'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import { useProgressiveEnrichment } from '@/hooks/use-progressive-enrichment'

function HashtagPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tag = searchParams.get('tag') || ''
  const { user } = useAuth()

  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [postCount, setPostCount] = useState(0)

  // Progressive enrichment - renders posts immediately, fills in data as it loads
  // enrichmentState is destructured to trigger re-renders when enrichment data arrives
  const { enrichProgressively, enrichmentState, getPostEnrichment, reset: resetEnrichment } = useProgressiveEnrichment({
    currentUserId: user?.identityId
  })

  // Determine if this is a cashtag and get display values
  const isCashtag = isCashtagStorage(tag)
  const displayTag = isCashtag ? cashtagStorageToDisplay(tag) : tag
  const tagSymbol = isCashtag ? '$' : '#'
  const TagIcon = isCashtag ? CurrencyDollarIcon : HashtagIcon

  useEffect(() => {
    const loadHashtagPosts = async () => {
      if (!tag) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      resetEnrichment()
      try {
        // Check if hashtag contract is deployed
        if (!HASHTAG_CONTRACT_ID) {
          console.log('Hashtag contract not deployed, showing empty state')
          setPosts([])
          setPostCount(0)
          setIsLoading(false)
          return
        }

        // Get post IDs that have this hashtag
        const hashtagDocs = await hashtagService.getPostIdsByHashtag(tag, { limit: 50 })

        if (hashtagDocs.length === 0) {
          setPosts([])
          setPostCount(0)
          setIsLoading(false)
          return
        }

        // Fetch the actual posts using postService
        const { postService } = await import('@/lib/services/post-service')

        const postIds = Array.from(new Set(hashtagDocs.map(h => h.postId)))

        // Batch fetch all posts at once
        const allPosts = await postService.getPostsByIds(postIds)

        // Validate ownership - filter to posts where hashtag was created by post owner
        const fetchedPosts = allPosts.filter(post => {
          const hashtagDoc = hashtagDocs.find(h => h.postId === post.id)
          return hashtagDoc && hashtagDoc.$ownerId === post.author.id
        })

        // Sort by creation date (newest first)
        fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

        // Filter out posts from blocked users (before setting)
        let visiblePosts = fetchedPosts
        if (user?.identityId && fetchedPosts.length > 0) {
          const authorIds = Array.from(new Set(fetchedPosts.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(user.identityId, authorIds)
          visiblePosts = fetchedPosts.filter(post => !blockedMap.get(post.author.id))
        }

        // Set posts immediately (with placeholder author data)
        setPosts(visiblePosts)
        setPostCount(visiblePosts.length)

        // Start progressive enrichment (non-blocking)
        enrichProgressively(visiblePosts)
      } catch (error) {
        console.error('Failed to load hashtag posts:', error)
        setPosts([])
      } finally {
        setIsLoading(false)
      }
    }

    loadHashtagPosts()
  }, [tag, user?.identityId, enrichProgressively, resetEnrichment])

  if (!tag) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        <Sidebar />
        <div className="flex-1 flex justify-center min-w-0">
          <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
            <div className="p-12 text-center">
              <HashtagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">No hashtag specified</h2>
              <p className="text-gray-500">
                Search for a hashtag to see related posts
              </p>
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
          {/* Header */}
          <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-4 p-4">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold flex items-center gap-1">
                  <TagIcon className="h-5 w-5 text-yappr-500" />
                  {displayTag}
                </h1>
                <p className="text-sm text-gray-500">
                  {formatNumber(postCount)} {postCount === 1 ? 'post' : 'posts'}
                </p>
              </div>
            </div>
          </header>

          {/* Content */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {isLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
                <p className="text-gray-500">Loading posts with {tagSymbol}{displayTag}...</p>
              </div>
            ) : posts.length === 0 ? (
              <div className="p-12 text-center">
                <TagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">No posts yet</h2>
                <p className="text-gray-500 mb-4">
                  Be the first to post with {tagSymbol}{displayTag}
                </p>
                {!HASHTAG_CONTRACT_ID && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    Hashtag contract not deployed. Run `node register-hashtag-contract.js` to enable.
                  </p>
                )}
              </div>
            ) : (
              posts.map((post, index) => (
                <motion.div
                  key={post.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <PostCard post={post} enrichment={getPostEnrichment(post)} />
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

export default function HashtagPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      </div>
    }>
      <HashtagPageContent />
    </Suspense>
  )
}
