'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { MagnifyingGlassIcon, ArrowLeftIcon, HashtagIcon, DocumentTextIcon, TrophyIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { PostCard } from '@/components/post/post-card'
import { Spinner } from '@/components/ui/spinner'
import { PostListSkeleton } from '@/components/post/post-card-skeleton'
import { BlogPostCard, BlogPostCardSkeleton } from '@/components/blog/blog-post-card'
import { useRouter } from 'next/navigation'
import { hashtagService, TrendingHashtag } from '@/lib/services/hashtag-service'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { TrendingHashtagRow, TrendingHashtagRowSkeleton } from '@/components/explore/trending-hashtag-row'
import { ScrollTabs, scrollTabId } from '@/components/ui/scroll-tabs'
import { likesAreIndexOnly, prefixRankingsAvailable } from '@/lib/contract-topology'
import { RankingWindowToggle } from '@/components/explore/ranking-window-toggle'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import { TopCreators } from '@/components/explore/top-creators'
import type { Post, Blog, BlogPostWithAuthor } from '@/lib/types'
import Link from 'next/link'
import { BLOG_POSTS_DISCOVERY_URL, boundedPostListState, enrichBlogPostsWithAuthors, enrichBlogPostsWithBlogNames, getBlogPostUrl } from '@/lib/blog/content-utils'
import { blogIsV7 } from '@/lib/constants'

type ExploreTab = 'hashtags' | 'top' | 'creators' | 'blogs'

export default function ExplorePage() {
  const router = useRouter()
  const { user } = useAuth()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)
  const [activeTab, setActiveTab] = useState<ExploreTab>('hashtags')
  // Tabs opened so far: their panels stay mounted (hidden when inactive).
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<ExploreTab>>(() => new Set<ExploreTab>(['hashtags']))
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [searchResults, setSearchResults] = useState<Post[]>([])
  const [blogSearchResults, setBlogSearchResults] = useState<BlogPostWithAuthor[]>([])
  const [isSearching, setIsSearching] = useState(false)
  // Each ranked list is kept per window, so switching back to a window (or a
  // tab) shows the last result at once; a skeleton only covers a first load.
  const [trendingByWindow, setTrendingByWindow] = useState<Partial<Record<RankingWindow, TrendingHashtag[]>>>({})
  const [recentBlogPosts, setRecentBlogPosts] = useState<BlogPostWithAuthor[]>([])
  const [isLoadingBlogs, setIsLoadingBlogs] = useState(true)
  // v7: the bounded timeline read stopped with more posts after it (see boundedPostListState).
  const [moreBlogPostsAfter, setMoreBlogPostsAfter] = useState<string | undefined>()
  const [topByWindow, setTopByWindow] = useState<Partial<Record<RankingWindow, Post[]>>>({})
  // Each ranked tab keeps its own window: the axes' windows differ (v10: 24h
  // tags, 3-day posts, all-time creators), so one choice must not leak across.
  const [trendingWindow, setTrendingWindow] = useState<RankingWindow>('all')
  const [topWindow, setTopWindow] = useState<RankingWindow>('all')
  const [creatorsWindow, setCreatorsWindow] = useState<RankingWindow>('all')
  const blogsLoadedRef = useRef(false)
  const blogCacheRef = useRef<{ blogIds: string[]; blogMap: Map<string, Blog> } | null>(null)
  const trendingHashtags = trendingByWindow[trendingWindow]
  const topPosts = topByWindow[topWindow]

  const selectTab = useCallback((tab: ExploreTab) => {
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
    // Keep the URL in step without a navigation (so nothing remounts).
    const url = new URL(window.location.href)
    if (tab === 'hashtags') url.searchParams.delete('tab')
    else url.searchParams.set('tab', tab)
    window.history.replaceState(window.history.state, '', url)
  }, [])

  // Open the tab the URL names (?tab=top|creators|blogs), once on mount.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    const available: ExploreTab[] = [
      ...(likesAreIndexOnly() ? (['top'] as const) : []),
      ...(prefixRankingsAvailable() ? (['creators'] as const) : []),
      'blogs',
    ]
    const match = available.find((tab) => tab === requested)
    if (match) selectTab(match)
  }, [selectTab])

  // Load the global most-liked posts while the Top tab is open (v9 on — the
  // ranking is one proved `documents.ranked()` page). A revisit shows the kept
  // list and refreshes it quietly; hydration is session-cached for a minute.
  useEffect(() => {
    if (activeTab !== 'top' || !likesAreIndexOnly()) return
    const win = topWindow

    const loadTopPosts = async () => {
      try {
        const { topLikedPostsHydrated } = await import('@/lib/services/ranked-likes')
        let posts = await topLikedPostsHydrated({ limit: 20, window: win })

        // Filter out posts from blocked users, same as the search results above.
        if (user?.identityId && posts.length > 0) {
          const authorIds = Array.from(new Set(posts.map(p => p.author.id)))
          const blockedMap = await checkBlockedForAuthors(user.identityId, authorIds)
          posts = posts.filter(post => !blockedMap.get(post.author.id))
        }

        setTopByWindow((prev) => ({ ...prev, [win]: posts }))
      } catch (error) {
        logger.error('Failed to load top posts:', error)
        // Keep a list already on screen; only a first load falls back to empty.
        setTopByWindow((prev) => (prev[win] ? prev : { ...prev, [win]: [] }))
      }
    }

    loadTopPosts().catch(err => logger.error('Failed to load top posts:', err))
  }, [activeTab, user?.identityId, topWindow])

  // Load trending hashtags (the hashtag service caches each window for 5 minutes).
  useEffect(() => {
    const win = trendingWindow
    const loadTrendingHashtags = async () => {
      try {
        const trending = await hashtagService.getTrendingHashtags({
          timeWindowHours: 168, // 1 week
          minPosts: 1,
          limit: 12,
          window: win,
        })
        setTrendingByWindow((prev) => ({ ...prev, [win]: trending }))
      } catch (error) {
        logger.error('Failed to load trending hashtags:', error)
        setTrendingByWindow((prev) => (prev[win] ? prev : { ...prev, [win]: [] }))
      }
    }

    loadTrendingHashtags().catch(err => logger.error('Failed to load trending hashtags:', err))
  }, [trendingWindow])

  // Discovery is lazy; search has its own blog loader.
  useEffect(() => {
    if (activeTab !== 'blogs' || blogsLoadedRef.current) return
    blogsLoadedRef.current = true
    const loadRecentBlogPosts = async () => {
      try {
        setIsLoadingBlogs(true)
        const { blogService, blogPostService } = await import('@/lib/services')

        // v7 lists the latest posts across every blog off the post timeline
        // (reading on past drafts and tombstones), then names their blogs;
        // earlier cuts read every blog's newest posts.
        if (blogIsV7()) {
          const { posts, nextCursor } = await blogPostService.getLatestPublishedPosts({ want: 10, maxPages: 5 })
          setRecentBlogPosts((await enrichBlogPostsWithBlogNames(posts)).slice(0, 10))
          setMoreBlogPostsAfter(nextCursor)
          return
        }

        const { blogs: allBlogs } = await blogService.getNewestBlogs()
        if (allBlogs.length === 0) {
          setRecentBlogPosts([])
          return
        }

        const blogMap = new Map(allBlogs.map(b => [b.id, b]))
        const blogIds = allBlogs.map(b => b.id)
        blogCacheRef.current = { blogIds, blogMap }
        const recentPosts = await blogPostService.getRecentPosts(blogIds, 10)

        if (recentPosts.length === 0) {
          setRecentBlogPosts([])
          return
        }

        const postsWithAuthors = await enrichBlogPostsWithAuthors(recentPosts, blogMap)
        setRecentBlogPosts(postsWithAuthors)
      } catch (error) {
        logger.error('Failed to load recent blog posts:', error)
        setRecentBlogPosts([])
      } finally {
        setIsLoadingBlogs(false)
      }
    }

    loadRecentBlogPosts().catch(err => logger.error('Failed to load blog posts:', err))
  }, [activeTab])

  // Search posts and blog posts when query changes
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([])
      setBlogSearchResults([])
      setIsSearching(false)
      return
    }

    const searchAll = async () => {
      try {
        setIsSearching(true)

        // Search regular posts: a client-side substring match over the most
        // recent timeline page. Authors are left as placeholders for PostCard
        // to resolve progressively.
        const { postService } = await import('@/lib/services/post-service')
        const { documents: recentPosts } = await postService.getTimeline({ limit: 100 })

        const authorIds = Array.from(new Set(recentPosts.map(p => p.author.id).filter(Boolean)))
        const blockedMap = user?.identityId
          ? await checkBlockedForAuthors(user.identityId, authorIds)
          : new Map<string, boolean>()

        const needle = searchQuery.toLowerCase()
        const filtered = recentPosts
          .filter(post =>
            !post.deleted &&
            post.content.toLowerCase().includes(needle) &&
            !blockedMap.get(post.author.id)
          )
          .map(post => ({
            ...post,
            author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined },
          }))

        setSearchResults(await postService.enrichPostsBatch(filtered))

        // Search blog posts — reuse cached blog data from mount when available
        const { blogPostService } = await import('@/lib/services')

        let cached = blogCacheRef.current
        if (!cached) {
          const { blogService } = await import('@/lib/services')
          const { blogs: allBlogs } = await blogService.getNewestBlogs()
          const blogMap = new Map(allBlogs.map(b => [b.id, b]))
          const blogIds = allBlogs.map(b => b.id)
          cached = { blogIds, blogMap }
          blogCacheRef.current = cached
        }

        if (cached.blogIds.length > 0) {
          const matchingBlogPosts = await blogPostService.searchPosts(cached.blogIds, searchQuery, 10)
          const blogResults = await enrichBlogPostsWithAuthors(matchingBlogPosts, cached.blogMap)
          setBlogSearchResults(blogResults)
        } else {
          setBlogSearchResults([])
        }
      } catch (error) {
        logger.error('Search failed:', error)
        setSearchResults([])
        setBlogSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }

    const debounceTimer = setTimeout(searchAll, 300)
    return () => clearTimeout(debounceTimer)
  }, [searchQuery, user?.identityId])

  const handleBlogPostClick = (post: BlogPostWithAuthor) => {
    if (post.blogId && post.slug) {
      router.push(getBlogPostUrl(post.blogId, post.slug))
    }
  }

  return (
    <PageShell>
          <PageHeader borderless={!searchQuery}>
            <div className="flex items-center gap-4 p-4">
              {isSearchFocused && (
                <button
                  aria-label="Close search"
                  onClick={() => {
                    setIsSearchFocused(false)
                    setSearchQuery('')
                  }}
                  className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900"
                >
                  <ArrowLeftIcon className="h-5 w-5" />
                </button>
              )}

              <div className="relative flex-1">
                <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  placeholder="Search posts and blog articles"
                  className="w-full h-12 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
                />
              </div>
            </div>

            {!searchQuery && (
              <ScrollTabs
                ariaLabel="Explore"
                panelId="explore-panel"
                active={activeTab}
                onSelect={selectTab}
                tabs={[
                  { key: 'hashtags' as const, label: 'Trending' },
                  // Server-ranked global Top posts need the v9 ranked like axes.
                  ...(likesAreIndexOnly() ? [{ key: 'top' as const, label: 'Top', testId: 'explore-top-tab' }] : []),
                  // The creator leaderboard needs the v9 prefix ranked axes
                  // (byAuthorPost / v10 byAuthorPostTime at-form) — no earlier contract can serve it.
                  ...(prefixRankingsAvailable() ? [{ key: 'creators' as const, label: 'Creators', testId: 'explore-creators-tab' }] : []),
                  { key: 'blogs' as const, label: 'Blogs' },
                ]}
              />
            )}
          </PageHeader>

          {searchQuery && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                {isSearching ? (
                  <div className="p-8 text-center">
                    <Spinner size="md" className="mx-auto mb-4" />
                    <p className="text-gray-500">Searching...</p>
                  </div>
                ) : (searchResults.length > 0 || blogSearchResults.length > 0) ? (
                  <>
                    {/* Blog post search results */}
                    {blogSearchResults.length > 0 && (
                      <div>
                        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                            <DocumentTextIcon className="h-4 w-4" />
                            Blog Posts ({blogSearchResults.length})
                          </h3>
                        </div>
                        {blogSearchResults.map((post) => (
                          <BlogPostCard
                            key={post.id}
                            post={post}
                            onClick={handleBlogPostClick}
                            className="border-b border-gray-200 dark:border-gray-800"
                          />
                        ))}
                      </div>
                    )}

                    {/* Regular post search results */}
                    {searchResults.length > 0 && (
                      <div>
                        {blogSearchResults.length > 0 && (
                          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                              Posts ({searchResults.length})
                            </h3>
                          </div>
                        )}
                        {filterHiddenSensitive(searchResults, sensitiveContentMode, user?.identityId).map((post) => <PostCard key={post.id} post={post} />)}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="p-8 text-center">
                    <p className="text-gray-500">No results for &quot;{searchQuery}&quot;</p>
                    <p className="text-sm text-gray-400 mt-1">Try searching for something else</p>
                  </div>
                )}
              </motion.div>
            )}

          {/* Every visited tab stays mounted and is only hidden, so a revisit
              shows its content instantly: no fade, no skeleton, no refetch
              flash. Background refreshes swap rows in place. */}
          <div
            id="explore-panel"
            role="tabpanel"
            aria-labelledby={scrollTabId('explore-panel', activeTab)}
            hidden={!!searchQuery}
          >
            {visitedTabs.has('hashtags') && (
              <div hidden={activeTab !== 'hashtags'}>
                <RankingWindowToggle axis="hashtags" value={trendingWindow} onChange={setTrendingWindow} testIdPrefix="explore-trending" />
                <div className="divide-y divide-gray-200 dark:divide-gray-800">
                  {!trendingHashtags ? (
                    <TrendingHashtagRowSkeleton count={12} testId="explore-trending-loading" />
                  ) : trendingHashtags.length === 0 ? (
                    <div className="p-8 text-center">
                      <HashtagIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">No trending tags yet</p>
                      <p className="text-sm text-gray-400 mt-1">Post with #hashtags or $cashtags to see them here!</p>
                    </div>
                  ) : (
                    trendingHashtags.map((trend, index) => <TrendingHashtagRow key={trend.hashtag} trend={trend} index={index} />)
                  )}
                </div>
              </div>
            )}

            {visitedTabs.has('top') && (
              <div hidden={activeTab !== 'top'}>
                {/* Global most-liked posts (proved ranking, top 20) */}
                <RankingWindowToggle axis="posts" value={topWindow} onChange={setTopWindow} testIdPrefix="explore-top" />
                <div className="divide-y divide-gray-200 dark:divide-gray-800">
                  {!topPosts ? (
                    <PostListSkeleton count={8} label="Loading top posts" testId="explore-top-loading" />
                  ) : topPosts.length === 0 ? (
                    <div className="p-8 text-center" data-testid="explore-top-empty">
                      <TrophyIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">No liked posts yet</p>
                      <p className="text-sm text-gray-400 mt-1">The most-liked posts will appear here</p>
                    </div>
                  ) : (
                    filterHiddenSensitive(topPosts, sensitiveContentMode, user?.identityId).map((post) => (
                      <PostCard key={post.id} post={post} />
                    ))
                  )}
                </div>
              </div>
            )}

            {visitedTabs.has('creators') && (
              <div hidden={activeTab !== 'creators'}>
                {/* v9 creator leaderboard (proved prefix rankings). */}
                <RankingWindowToggle axis="creators" value={creatorsWindow} onChange={setCreatorsWindow} testIdPrefix="explore-creators" />
                <TopCreators window={creatorsWindow} />
              </div>
            )}

            {visitedTabs.has('blogs') && (
              <div hidden={activeTab !== 'blogs'}>
                {isLoadingBlogs ? (
                  <BlogPostCardSkeleton count={10} />
                ) : boundedPostListState(recentBlogPosts.length, moreBlogPostsAfter) === 'filtered' ? (
                  <div className="p-8 text-center">
                    <DocumentTextIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                    <p className="text-gray-500">No published posts among the newest ones read</p>
                    <Link href={BLOG_POSTS_DISCOVERY_URL} className="mt-2 inline-block text-sm font-medium text-yappr-600 hover:text-yappr-700 dark:text-yappr-400">
                      Browse all posts
                    </Link>
                  </div>
                ) : recentBlogPosts.length === 0 ? (
                  <div className="p-8 text-center">
                    <DocumentTextIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                    <p className="text-gray-500">No blog posts yet</p>
                    <p className="text-sm text-gray-400 mt-1">Be the first to publish an article!</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {recentBlogPosts.map((post) => (
                      <BlogPostCard
                        key={post.id}
                        post={post}
                        onClick={handleBlogPostClick}
                      />
                    ))}
                    {moreBlogPostsAfter && (
                      <div className="p-4 text-center">
                        <Link href={BLOG_POSTS_DISCOVERY_URL} className="text-sm font-medium text-yappr-600 hover:text-yappr-700 dark:text-yappr-400">
                          Browse all posts
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
    </PageShell>
  )
}
