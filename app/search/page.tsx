'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, Suspense, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, ArrowPathIcon, MagnifyingGlassIcon, HashtagIcon, UserIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useSdk } from '@/contexts/sdk-context'
import { BlogPostCard } from '@/components/blog/blog-post-card'
import { formatNumber } from '@/lib/utils'
import { dpnsService } from '@/lib/services/dpns-service'
import { getPrimaryUsername } from '@/lib/utils/username'
import { hashtagService } from '@/lib/services/hashtag-service'
import { prefixRankingsAvailable } from '@/lib/contract-topology'
import { unifiedProfileService } from '@/lib/services'
import type { UnifiedProfileDocument } from '@/lib/services/unified-profile-service'
import type { BlogPostWithAuthor } from '@/lib/types'
import { enrichBlogPostsWithAuthors, getBlogPostUrl } from '@/lib/blog/content-utils'
import { MIN_QUERY_LENGTH, isSearchable } from '@/lib/search-query'

interface UserResult {
  id: string
  username: string
  displayName: string
  bio?: string
}

interface HashtagResult {
  hashtag: string
  /** Likes on tagged posts for a trending match on ranked cuts, else posts. */
  postCount: number
  unit: 'like' | 'post'
}

type Section = 'users' | 'hashtags' | 'blogPosts'

/** DPNS names starting with the query (or the exact name), with profile display names. Rejects when DPNS can't be read. */
async function searchUsers(query: string): Promise<UserResult[]> {
  const searchQuery = query.replace(/^@/, '')
  const dpnsResults = await dpnsService.findUsernamesByPrefix(searchQuery, 10)

  if (dpnsResults.length === 0) {
    const exactIdentity = await dpnsService.findIdentityByName(searchQuery)
    if (exactIdentity) {
      dpnsResults.push({
        username: `${searchQuery.toLowerCase().replace(/\.dash$/, '')}.dash`,
        ownerId: exactIdentity
      })
    }
  }

  if (dpnsResults.length === 0) return []

  const ownerIds = Array.from(new Set(dpnsResults.map(r => r.ownerId).filter(Boolean)))

  // Display names are optional: a failed profile read still lists the names.
  let profiles: UnifiedProfileDocument[] = []
  try {
    profiles = await unifiedProfileService.getProfilesByIdentityIds(ownerIds)
  } catch (error) {
    logger.error('Failed to fetch profiles:', error)
  }
  const profileMap = new Map(profiles.map(p => [p.$ownerId, p]))

  // One result per owner, picking the best matched name via the canonical ordering
  const ownerToNames = new Map<string, string[]>()
  for (const result of dpnsResults) {
    if (!result.ownerId) continue
    const names = ownerToNames.get(result.ownerId) || []
    names.push(result.username)
    ownerToNames.set(result.ownerId, names)
  }

  return Array.from(ownerToNames.entries()).map(([ownerId, names]) => {
    const profile = profileMap.get(ownerId)
    const primaryUsername = getPrimaryUsername(names) ?? names[0]
    return {
      id: ownerId,
      username: primaryUsername,
      displayName: profile?.displayName || primaryUsername,
      bio: profile?.bio
    }
  })
}

async function searchHashtags(searchQuery: string): Promise<HashtagResult[]> {
  const results: HashtagResult[] = []
  const normalizedQuery = searchQuery.replace(/^#/, '').toLowerCase()

  // Trending hashtags of the last week that contain the query
  const trending = await hashtagService.getTrendingHashtags({
    timeWindowHours: 168,
    minPosts: 1,
    limit: 50
  })
  const matchingTrending = trending.filter(h => h.hashtag.includes(normalizedQuery))

  // The ranked trending list counts likes on tagged posts (as the trending box says), not posts.
  const trendingUnit = prefixRankingsAvailable() ? 'like' : 'post'
  results.push(...matchingTrending.map((h) => ({ ...h, unit: trendingUnit } as const)))

  // An exact tag that isn't trending, if it has posts
  if (/^[a-z0-9_]{1,63}$/.test(normalizedQuery) && !results.some(h => h.hashtag === normalizedQuery)) {
    const postCount = await hashtagService.getPostCountByHashtag(normalizedQuery)
    if (postCount > 0) {
      results.unshift({ hashtag: normalizedQuery, postCount, unit: 'post' })
    }
  }

  return results
}

async function searchBlogPosts(searchQuery: string): Promise<BlogPostWithAuthor[]> {
  const { blogService, blogPostService } = await import('@/lib/services')

  const { blogs: allBlogs } = await blogService.getNewestBlogs()
  if (allBlogs.length === 0) return []

  const blogMap = new Map(allBlogs.map(b => [b.id, b]))
  const matchingPosts = await blogPostService.searchPosts(allBlogs.map(b => b.id), searchQuery, 10, { failWhenUnread: true })
  return enrichBlogPostsWithAuthors(matchingPosts, blogMap)
}

function SearchField({ query }: { query: string }) {
  const router = useRouter()
  const [value, setValue] = useState(query)

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = value.trim()
        if (trimmed) router.push(`/search?q=${encodeURIComponent(trimmed)}`)
      }}
    >
      <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
      <input
        type="search"
        enterKeyHint="search"
        aria-label="Search people and hashtags"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search people and hashtags"
        className="w-full h-12 pl-12 pr-4 bg-gray-100 dark:bg-gray-900 rounded-full focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:bg-transparent dark:focus:bg-transparent"
      />
    </form>
  )
}

function SectionEmpty({ failed, emptyText, onRetry }: { failed: boolean; emptyText: string; onRetry: () => void }) {
  return (
    <div className="p-8 text-center">
      {failed ? (
        <>
          <p className="mb-4 text-gray-500">Couldn&apos;t load these results.</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <ArrowPathIcon className="mr-2 h-4 w-4" />
            Try again
          </Button>
        </>
      ) : (
        <p className="text-gray-500">{emptyText}</p>
      )}
    </div>
  )
}

function SearchPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const query = searchParams.get('q') || ''
  const trimmedQuery = query.trim()
  const searchable = isSearchable(trimmedQuery)
  const { isReady: sdkReady, error: sdkError } = useSdk()

  const [users, setUsers] = useState<UserResult[]>([])
  const [hashtags, setHashtags] = useState<HashtagResult[]>([])
  const [blogPosts, setBlogPosts] = useState<BlogPostWithAuthor[]>([])
  const [failed, setFailed] = useState<ReadonlySet<Section>>(new Set())
  const [attempt, setAttempt] = useState(0)
  /** The query and attempt the shown results belong to; anything else is still loading. */
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const searchKey = `${attempt}:${trimmedQuery}`
  const searchIdRef = useRef(0)

  useEffect(() => {
    const currentSearchId = ++searchIdRef.current

    if (!searchable) {
      setUsers([])
      setHashtags([])
      setBlogPosts([])
      setFailed(new Set())
      setSettledFor(null)
      return
    }

    // On a direct load this effect runs before the SDK provider's, which
    // configures the SDK: searching now would fail and read as "no results".
    // A failed setup searches anyway, so the sections offer a retry.
    if (!sdkReady && !sdkError) return
    const key = `${attempt}:${trimmedQuery}`

    const performSearch = async () => {
      const [userResults, hashtagResults, blogResults] = await Promise.allSettled([
        searchUsers(trimmedQuery),
        searchHashtags(trimmedQuery),
        searchBlogPosts(trimmedQuery),
      ])
      if (currentSearchId !== searchIdRef.current) return

      const nextFailed = new Set<Section>()
      const settle = <T,>(section: Section, result: PromiseSettledResult<T[]>): T[] => {
        if (result.status === 'fulfilled') return result.value
        logger.error(`Search: ${section} search failed:`, result.reason)
        nextFailed.add(section)
        return []
      }
      setUsers(settle('users', userResults))
      setHashtags(settle('hashtags', hashtagResults))
      setBlogPosts(settle('blogPosts', blogResults))
      setFailed(nextFailed)
      setSettledFor(key)
    }

    performSearch().catch(err => logger.error('Search failed:', err))
  }, [trimmedQuery, searchable, sdkReady, sdkError, attempt])

  const retry = () => setAttempt((n) => n + 1)

  const handleUserClick = (userId: string) => {
    router.push(`/user?id=${userId}`)
  }

  const handleHashtagClick = (hashtag: string) => {
    router.push(`/hashtag?tag=${encodeURIComponent(hashtag)}`)
  }

  const handleBlogPostClick = (post: BlogPostWithAuthor) => {
    if (post.blogId && post.slug) {
      router.push(getBlogPostUrl(post.blogId, post.slug))
    }
  }

  if (!trimmedQuery) {
    return (
      <PageShell>
            <div className="p-4 lg:hidden">
              <SearchField query="" />
            </div>
            <div className="p-12 text-center">
              <MagnifyingGlassIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">Search Yappr</h2>
              <p className="text-gray-500">
                Find people by username, hashtags and blog posts
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
                aria-label="Back"
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold">Search</h1>
                <p className="text-sm text-gray-500">
                  Results for &quot;{trimmedQuery}&quot;
                </p>
              </div>
            </div>
            <div className="px-4 pb-3 lg:hidden">
              <SearchField key={query} query={query} />
            </div>
          </PageHeader>

          {/* Content */}
          {!searchable ? (
            <div className="p-8 text-center">
              <p className="text-gray-500">Type at least {MIN_QUERY_LENGTH} characters to search.</p>
            </div>
          ) : settledFor !== searchKey ? (
            <div className="p-8 text-center">
              <Spinner size="md" className="mx-auto mb-4" />
              <p className="text-gray-500">Searching...</p>
            </div>
          ) : (
            <div>
              {/* Users Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <UserIcon className="h-5 w-5" />
                    Users
                  </h2>
                </div>
                {users.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {users.map((user, index) => (
                      <motion.div
                        key={user.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => handleUserClick(user.id)}
                        className="flex items-center gap-3 p-4 hover:bg-gray-50 dark:hover:bg-gray-950 cursor-pointer transition-colors"
                      >
                        <div className="h-12 w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900">
                          <UserAvatar userId={user.id} size="lg" alt={user.displayName} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold truncate">{user.displayName}</h3>
                          <p className="text-sm text-gray-500 truncate">@{user.username}</p>
                          {user.bio && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 truncate mt-1">{user.bio}</p>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <SectionEmpty failed={failed.has('users')} emptyText="No users found" onRetry={retry} />
                )}
              </section>

              {/* Hashtags Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <HashtagIcon className="h-5 w-5" />
                    Hashtags
                  </h2>
                </div>
                {hashtags.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {hashtags.map((tag, index) => (
                      <motion.div
                        key={tag.hashtag}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => handleHashtagClick(tag.hashtag)}
                        className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 cursor-pointer transition-colors"
                      >
                        <p className="font-bold text-yappr-500">#{tag.hashtag}</p>
                        <p className="text-sm text-gray-500">
                          {formatNumber(tag.postCount)} {tag.unit}{tag.postCount === 1 ? '' : 's'}
                        </p>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <SectionEmpty failed={failed.has('hashtags')} emptyText="No hashtags found" onRetry={retry} />
                )}
              </section>

              {/* Blog Posts Section */}
              <section>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                  <h2 className="font-semibold flex items-center gap-2">
                    <DocumentTextIcon className="h-5 w-5" />
                    Blog Posts
                  </h2>
                </div>
                {blogPosts.length > 0 ? (
                  <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {blogPosts.map((post) => (
                      <BlogPostCard key={post.id} post={post} onClick={handleBlogPostClick} />
                    ))}
                  </div>
                ) : (
                  <SectionEmpty failed={failed.has('blogPosts')} emptyText="No blog posts found" onRetry={retry} />
                )}
              </section>
            </div>
          )}
    </PageShell>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="md" />
      </div>
    }>
      <SearchPageContent />
    </Suspense>
  )
}
