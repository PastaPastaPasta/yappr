'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, HashtagIcon, CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { PostCard } from '@/components/post/post-card'
import { Spinner } from '@/components/ui/spinner'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { formatNumber } from '@/lib/utils'
import { hashtagService } from '@/lib/services/hashtag-service'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { isCashtagStorage, cashtagStorageToDisplay } from '@/lib/post-helpers'
import { hashtagsAreInline, likesAreIndexOnly } from '@/lib/contract-topology'
import { RankingWindowToggle } from '@/components/explore/ranking-window-toggle'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import { LegacyYapprLink } from '@/components/ui/legacy-yappr-link'

const PAGE_SIZE = 50

function HashtagPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tag = searchParams.get('tag') || ''
  const { user } = useAuth()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)

  const [posts, setPosts] = useState<Post[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [lastPostId, setLastPostId] = useState<string | undefined>()
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadGeneration = useRef(0)
  const loadedGeneration = useRef<number | null>(null)
  const pendingPageGeneration = useRef<number | null>(null)
  const postCount = posts.length

  // Latest|Top sort (v4 only — Top is a proved ranked page on the tag-pinned
  // `like.byHashtagPost` axis). Latest stays the existing tagAndTime path.
  const [sortMode, setSortMode] = useState<'latest' | 'top'>('latest')
  /** v6: Top can show today's ranking (beat.byDayHashtagPost) or all-time. */
  const [rankingWindow, setRankingWindow] = useState<RankingWindow>('all')
  const [topPosts, setTopPosts] = useState<Post[]>([])
  const [topLoading, setTopLoading] = useState(false)
  const [topLoaded, setTopLoaded] = useState(false)

  // Determine if this is a cashtag and get display values
  const isCashtag = isCashtagStorage(tag)
  const displayTag = isCashtag ? cashtagStorageToDisplay(tag) : tag
  const tagSymbol = isCashtag ? '$' : '#'
  const TagIcon = isCashtag ? CurrencyDollarIcon : HashtagIcon

  useEffect(() => {
    const generation = ++loadGeneration.current
    let cancelled = false
    loadedGeneration.current = null
    pendingPageGeneration.current = null
    setPosts([])
    setHasMore(false)
    setLastPostId(undefined)
    setIsLoadingMore(false)
    const loadHashtagPosts = async () => {
      if (!tag) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const { postService } = await import('@/lib/services/post-service')

        let fetchedPosts: Post[]
        let preloaded: import('@/hooks/use-progressive-enrichment').PreloadedEnrichment | undefined
        if (hashtagsAreInline()) {
          // v4: posts carry their single hashtag inline — one `tagAndTime`
          // query IS the tag page (newest first), with no postHashtag
          // indirection and no ownership cross-check (the tag is a property of
          // the post itself).
          const page = await postService.queryForDisplay({
            where: [['hashtag', '==', tag], ['$createdAt', '>', 0]],
            orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']], limit: PAGE_SIZE,
          })
          if (cancelled) return
          fetchedPosts = page.documents
          preloaded = page.preloaded

          if (fetchedPosts.length === 0) {
            setPosts([])
            setIsLoading(false)
            return
          }
        } else {
          // Get post IDs that have this hashtag
          const hashtagDocs = await hashtagService.getPostIdsByHashtag(tag)
          if (cancelled) return

          if (hashtagDocs.length === 0) {
            setPosts([])
            setIsLoading(false)
            return
          }

          const postIds = Array.from(new Set(hashtagDocs.map(h => h.postId)))

          // Fetch referenced posts in bounded `$id in [...]` batches, then
          // retain the ownership check for legacy hashtag documents.
          const posts = await postService.getPostsByIds(postIds, { skipEnrichment: true })
          const authenticTags = new Set(hashtagDocs.map(tag => `${tag.postId}:${tag.$ownerId}`))
          fetchedPosts = posts.filter((post) => authenticTags.has(`${post.id}:${post.author.id}`))

          // Sort by creation date (newest first)
          fetchedPosts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }

        // Enrich posts with author data (DPNS names, displayNames, stats)
        let enrichedPosts = await postService.enrichPostsBatch(fetchedPosts.filter(post => !post.deleted), preloaded)

        // Filter out posts from blocked users
        if (user?.identityId && enrichedPosts.length > 0) {
          const authorIds = Array.from(new Set(enrichedPosts.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(user.identityId, authorIds)
          enrichedPosts = enrichedPosts.filter(post => !blockedMap.get(post.author.id))
        }

        if (cancelled) return
        loadedGeneration.current = generation
        setPosts(enrichedPosts)
        if (hashtagsAreInline()) {
          // Advance using the raw page, including posts hidden by viewer filters.
          setLastPostId(fetchedPosts[fetchedPosts.length - 1]?.id)
          setHasMore(fetchedPosts.length === PAGE_SIZE)
        }
      } catch (error) {
        logger.error('Failed to load hashtag posts:', error)
        if (!cancelled) setPosts([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadHashtagPosts().catch(err => logger.error('Failed to load hashtag posts:', err))
    return () => {
      cancelled = true
      // An old next-page request must not update a different tag or viewer.
      loadGeneration.current = generation + 1
    }
  }, [tag, user?.identityId])

  const loadMorePosts = useCallback(async () => {
    const generation = loadGeneration.current
    if (!tag || !hasMore || !lastPostId || isLoading || loadedGeneration.current !== generation || pendingPageGeneration.current === generation) return
    pendingPageGeneration.current = generation
    setIsLoadingMore(true)
    try {
      const { postService } = await import('@/lib/services/post-service')
      const result = await postService.queryForDisplay({
        where: [['hashtag', '==', tag], ['$createdAt', '>', 0]],
        orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']],
        limit: PAGE_SIZE, startAfter: lastPostId,
      })
      const page = result.documents
      let enriched = await postService.enrichPostsBatch(page.filter(post => !post.deleted), result.preloaded)
      if (user?.identityId && enriched.length > 0) {
        const authors = Array.from(new Set(enriched.map(post => post.author.id)))
        const blocked = await checkBlockedForAuthors(user.identityId, authors)
        enriched = enriched.filter(post => !blocked.get(post.author.id))
      }
      if (loadGeneration.current !== generation) return
      setPosts(current => {
        const seen = new Set(current.map(post => post.id))
        return [...current, ...enriched.filter(post => !seen.has(post.id))]
      })
      if (page.length > 0) setLastPostId(page[page.length - 1].id)
      setHasMore(page.length === PAGE_SIZE)
    } catch (error) {
      // A stale failure must not suspend the new list's infinite scroll.
      if (loadGeneration.current === generation) throw error
    } finally {
      if (loadGeneration.current === generation) {
        pendingPageGeneration.current = null
        setIsLoadingMore(false)
      }
    }
  }, [tag, hasMore, lastPostId, isLoading, user?.identityId])

  const { sentinelRef, isSuspended, loadMore } = useInfiniteScroll({
    hasMore,
    isLoading: isLoading || isLoadingMore,
    onLoadMore: loadMorePosts,
    disabled: sortMode !== 'latest' || !hashtagsAreInline(),
    resetKey: `${tag}:${user?.identityId ?? ''}`,
  })

  // Reset the sort state when the tag changes.
  useEffect(() => {
    setSortMode('latest')
    setTopPosts([])
    setTopLoaded(false)
  }, [tag])

  // A window change reads a different index: drop the loaded Top list.
  useEffect(() => {
    setTopLoaded(false)
  }, [rankingWindow])

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
        let fetched = await topLikedPostsHydrated({ hashtag: tag, limit: 20, window: rankingWindow })

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
  }, [sortMode, topLoaded, tag, user?.identityId, rankingWindow])

  if (!tag) {
    return (
      <PageShell>
            <div className="p-12 text-center">
              <HashtagIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">No hashtag specified</h2>
              <p className="text-gray-500">
                Search for a hashtag to see related posts
              </p>
            </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
          {/* Header */}
          <PageHeader>
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
                  {formatNumber(postCount)}{hasMore ? '+' : ''} {postCount === 1 && !hasMore ? 'post' : 'posts'}
                </p>
              </div>
            </div>
          </PageHeader>

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
          {sortMode === 'top' && (
            <RankingWindowToggle value={rankingWindow} onChange={setRankingWindow} testIdPrefix="hashtag-top" />
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
            ) : sortMode === 'latest' && posts.length === 0 && !hasMore ? (
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
                  transition={{ delay: Math.min(index, 9) * 0.05 }}
                >
                  <PostCard post={post} />
                </motion.div>
              ))
            )}
          </div>
          {sortMode === 'latest' && !isLoading && hasMore && (
            <InfiniteScrollSentinel
              sentinelRef={sentinelRef}
              isLoading={isLoadingMore}
              isSuspended={isSuspended}
              onLoadMore={loadMore}
              label="Load more posts"
            />
          )}
    </PageShell>
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
