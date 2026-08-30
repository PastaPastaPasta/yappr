'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, HashtagIcon, CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/utils'
import { hashtagService } from '@/lib/services/hashtag-service'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import { hashtagsAreInline, likesAreIndexOnly } from '@/lib/contract-topology'
import { LegacyYapprLink } from '@/components/ui/legacy-yappr-link'

function HashtagPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tag = searchParams.get('tag') || ''
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)

  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [postCount, setPostCount] = useState(0)

  // Latest|Top sort (v4 only — Top is a proved ranked page on the tag-pinned
  // `like.byHashtagPost` axis). Latest stays the existing tagAndTime path.
  const [sortMode, setSortMode] = useState<'latest' | 'top'>('latest')
  const [topPosts, setTopPosts] = useState<Post[]>([])
  const [topLoading, setTopLoading] = useState(false)
  const [topLoaded, setTopLoaded] = useState(false)

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
      try {
        const { postService } = await import('@/lib/services/post-service')

        let fetchedPosts: Post[]
        if (hashtagsAreInline()) {
          // v4: posts carry their single hashtag inline — one `tagAndTime`
          // query IS the tag page (newest first), with no postHashtag
          // indirection and no ownership cross-check (the tag is a property of
          // the post itself).
          fetchedPosts = await postService.getPostsByHashtag(tag)
          setPostCount(fetchedPosts.length)

          if (fetchedPosts.length === 0) {
            setPosts([])
            setIsLoading(false)
            return
          }
        } else {
          // Get post IDs that have this hashtag
          const hashtagDocs = await hashtagService.getPostIdsByHashtag(tag)
          setPostCount(hashtagDocs.length)

          if (hashtagDocs.length === 0) {
            setPosts([])
            setIsLoading(false)
            return
          }

          const postIds = Array.from(new Set(hashtagDocs.map(h => h.postId)))

          // Fetch posts and validate ownership
          fetchedPosts = []
          for (const postId of postIds) {
            try {
              const post = await postService.get(postId)
              if (post) {
                // Verify hashtag was created by post owner (security filter)
                const hashtagDoc = hashtagDocs.find(h => h.postId === postId)
                if (hashtagDoc && hashtagDoc.$ownerId === post.author.id) {
                  fetchedPosts.push(post)
                }
              }
            } catch (error) {
              logger.error('Failed to fetch post:', postId, error)
            }
          }

          // Sort by creation date (newest first)
          fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }

        // Enrich posts with author data (DPNS names, displayNames, stats)
        let enrichedPosts = await postService.enrichPostsBatch(fetchedPosts)

        // Filter out posts from blocked users
        if (user?.identityId && enrichedPosts.length > 0) {
          const authorIds = Array.from(new Set(enrichedPosts.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(user.identityId, authorIds)
          enrichedPosts = enrichedPosts.filter(post => !blockedMap.get(post.author.id))
        }

        setPosts(enrichedPosts)
        setPostCount(enrichedPosts.length)
      } catch (error) {
        logger.error('Failed to load hashtag posts:', error)
        setPosts([])
      } finally {
        setIsLoading(false)
      }
    }

    loadHashtagPosts().catch(err => logger.error('Failed to load hashtag posts:', err))
  }, [tag, user?.identityId])

  // Reset the sort state when the tag changes.
  useEffect(() => {
    setSortMode('latest')
    setTopPosts([])
    setTopLoaded(false)
  }, [tag])

  // The block filter depends on the viewer, so a Top list loaded under one
  // identity is stale after login/logout — force a refetch.
  useEffect(() => {
    setTopLoaded(false)
  }, [user?.identityId])

  // Lazy-load the tag's top-liked posts the first time Top is selected.
  useEffect(() => {
    // `tag` is never '' here (the page early-returns without one), so the
    // untagged '' group is never queried.
    if (sortMode !== 'top' || topLoaded || !tag || !likesAreIndexOnly()) return

    const loadTopPosts = async () => {
      setTopLoading(true)
      try {
        const { topLikedPostsHydrated } = await import('@/lib/services/ranked-likes')
        let fetched = await topLikedPostsHydrated({ hashtag: tag, limit: 20 })

        // Filter out posts from blocked users, matching the Latest path.
        if (user?.identityId && fetched.length > 0) {
          const authorIds = Array.from(new Set(fetched.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(user.identityId, authorIds)
          fetched = fetched.filter(post => !blockedMap.get(post.author.id))
        }

        setTopPosts(fetched)
      } catch (error) {
        logger.error('Failed to load top posts for hashtag:', error)
        setTopPosts([])
      } finally {
        setTopLoading(false)
        setTopLoaded(true)
      }
    }

    loadTopPosts().catch(err => logger.error('Failed to load top posts for hashtag:', err))
  }, [sortMode, topLoaded, tag, user?.identityId])

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
          <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
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

          {/* Latest|Top sort toggle — Top rides the v4 ranked like axes. */}
          {likesAreIndexOnly() && (
            <div className="flex gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <button
                onClick={() => setSortMode('latest')}
                data-testid="hashtag-sort-latest"
                className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                  sortMode === 'latest'
                    ? 'bg-yappr-500 text-white'
                    : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                Latest
              </button>
              <button
                onClick={() => setSortMode('top')}
                data-testid="hashtag-sort-top"
                className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                  sortMode === 'top'
                    ? 'bg-yappr-500 text-white'
                    : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                Top
              </button>
            </div>
          )}

          {/* Content */}
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {(sortMode === 'top' ? topLoading || !topLoaded : isLoading) ? (
              <div className="p-8 text-center">
                <Spinner size="md" className="mx-auto mb-4" />
                <p className="text-gray-500">
                  {sortMode === 'top'
                    ? `Loading top posts with ${tagSymbol}${displayTag}...`
                    : `Loading posts with ${tagSymbol}${displayTag}...`}
                </p>
              </div>
            ) : sortMode === 'top' && topPosts.length === 0 ? (
              <div className="p-12 text-center" data-testid="hashtag-top-empty">
                <TagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">No liked posts yet</h2>
                <p className="text-gray-500 mb-4">
                  Posts with {tagSymbol}{displayTag} will rank here once they get likes
                </p>
              </div>
            ) : sortMode === 'latest' && posts.length === 0 ? (
              <div className="p-12 text-center">
                <TagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">No posts yet</h2>
                <p className="text-gray-500 mb-4">
                  Be the first to post with {tagSymbol}{displayTag}
                </p>
                <LegacyYapprLink />
              </div>
            ) : (
              filterHiddenSensitive(sortMode === 'top' ? topPosts : posts, sensitiveContentMode, user?.identityId).map((post, index) => (
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

export default function HashtagPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-40px)] flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <HashtagPageContent />
    </Suspense>
  )
}
