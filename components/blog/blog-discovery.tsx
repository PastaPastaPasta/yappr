'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { blogService } from '@/lib/services'
import { blogStatsService, trendingBlogsCopy } from '@/lib/services/blog-stats-service'
import { dpnsService } from '@/lib/services/dpns-service'
import type { Blog } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { useAuth } from '@/contexts/auth-context'
import { useBlogFollow } from '@/hooks/use-blog-follow'
import { blogFollowStatusCache } from '@/lib/caches/user-status-cache'
import { blogIsV2, blogIsV7 } from '@/lib/constants'
import { getBlogUrl } from '@/lib/blog/content-utils'
import { useCursorList, type CursorPage } from '@/hooks/use-cursor-list'
import { Button } from '@/components/ui/button'
import { BlogPostDiscovery } from './blog-post-discovery'
import { PillTabs } from './pill-tabs'
import { DISCOVERY_SCAN_LIMIT } from '@/lib/services/pagination-utils'

interface BlogWithUsername extends Blog {
  username: string | null
}

/**
 * Discovery orderings. `newest` is v7's `blog.timeline`, paged newest first;
 * before v7 it pages every blog (up to DISCOVERY_SCAN_LIMIT) and sorts
 * client-side (the only shape v1 can serve). The other two are v2 proved
 * rankings, one request each, hydrated with a single by-id fetch; `trending`
 * covers today up to v6 and the last ~3 days on v7.
 */
const SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'followed', label: 'Most followed' },
  { key: 'trending', label: 'Trending' },
] as const

type BlogSort = (typeof SORTS)[number]['key']

/** Blogs per `newest` page on v7. */
const NEWEST_PAGE_SIZE = 50

/**
 * One load of blogs for `sort`. `nextCursor` is set when v7's newest list has
 * more; `incomplete` when an older cut's newest scan stopped at its cap.
 */
async function loadBlogs(sort: BlogSort, startAfter?: string): Promise<{ blogs: Blog[]; nextCursor?: string; incomplete?: boolean }> {
  if (sort !== 'newest') return { blogs: await rankedBlogs(sort) }
  if (blogIsV7()) return blogService.getBlogTimelinePage({ limit: NEWEST_PAGE_SIZE, startAfter })
  const { blogs, complete } = await blogService.getNewestBlogs(100)
  return { blogs, incomplete: !complete }
}

/** The blogs a ranked page names, in the proved order; absent ids are dropped. */
async function rankedBlogs(sort: Exclude<BlogSort, 'newest'>): Promise<Blog[]> {
  const ranked = sort === 'followed'
    ? await blogStatsService.mostFollowedBlogs(100)
    : await blogStatsService.trendingBlogs(100)
  if (ranked.length === 0) return []
  const byId = new Map((await blogService.getMany(ranked.map((entry) => entry.id))).map((blog) => [blog.id, blog]))
  return ranked.flatMap((entry) => {
    const blog = byId.get(entry.id)
    return blog ? [blog] : []
  })
}

/** Usernames for a page of blogs, with the viewer's follow status prefetched for their cards. */
async function hydrateBlogs(blogs: Blog[], viewerId: string | undefined): Promise<BlogWithUsername[]> {
  const usernameMap = await dpnsService.resolveUsernamesBatch(Array.from(new Set(blogs.map((b) => b.ownerId))))
  if (viewerId) {
    try {
      const { blogFollowService } = await import('@/lib/services/blog-follow-service')
      const statusMap = await blogFollowService.getFollowStatusBatch(blogs.map((b) => b.id), viewerId)
      blogFollowStatusCache.seed(viewerId, statusMap)
    } catch {
      // Non-critical, individual hooks will query on their own
    }
  }
  return blogs.map((blog) => ({ ...blog, username: usernameMap.get(blog.ownerId) ?? null }))
}

/**
 * `/blog` discovery. On v7 a Blogs / Posts switch adds the cross-blog post
 * lists ({@link BlogPostDiscovery}); earlier cuts list blogs only.
 */
export function BlogDiscovery({ sdkReady = true, showHeader = false }: { sdkReady?: boolean; showHeader?: boolean }) {
  const [view, setView] = useState<'blogs' | 'posts'>('blogs')
  const postsView = blogIsV7() && view === 'posts'

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="text-center">
          <h2 className="text-xl font-bold">Discover Blogs</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Long-form content published on Yappr
          </p>
        </div>
      )}

      {blogIsV7() && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-900" role="tablist" aria-label="Discover">
          {(['blogs', 'posts'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={`rounded-md py-1.5 text-sm font-medium transition ${
                view === key
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-neutral-800 dark:text-white'
                  : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
              }`}
            >
              {key === 'blogs' ? 'Blogs' : 'Posts'}
            </button>
          ))}
        </div>
      )}

      {postsView ? <BlogPostDiscovery sdkReady={sdkReady} /> : <BlogList sdkReady={sdkReady} />}
    </div>
  )
}

function BlogList({ sdkReady }: { sdkReady: boolean }) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<BlogSort>('newest')
  const { user } = useAuth()
  const viewerId = user?.identityId
  const trending = trendingBlogsCopy()
  const sorts = useMemo(() => SORTS.map((option) => (option.key === 'trending' ? { ...option, label: trending.label } : option)), [trending.label])
  const loadPage = useCallback(async (cursor?: string): Promise<CursorPage<BlogWithUsername>> => {
    const page = await loadBlogs(sort, cursor)
    return { items: await hydrateBlogs(page.blogs, viewerId), nextCursor: page.nextCursor, incomplete: page.incomplete }
  }, [sort, viewerId])
  // `incomplete`: before v7, `newest` sorted only the first DISCOVERY_SCAN_LIMIT blogs read.
  const { items: blogs, cursor, loading, loadingMore, error, incomplete, loadMore } = useCursorList(loadPage, {
    enabled: sdkReady, loadError: 'Failed to load blogs', moreError: 'Failed to load more blogs',
  })

  const filtered = useMemo(() => {
    if (!search.trim()) return blogs
    const q = search.trim().toLowerCase()
    return blogs.filter(
      (b) =>
        b.name.toLowerCase().startsWith(q) ||
        (b.username && b.username.toLowerCase().startsWith(q))
    )
  }, [blogs, search])

  return (
    <div className="space-y-4">
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          placeholder="Search blogs by name or username..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-yappr-500 focus:ring-1 focus:ring-yappr-500 dark:border-gray-700 dark:bg-neutral-900 dark:text-white dark:placeholder-gray-500"
        />
      </div>

      {blogIsV2() && <PillTabs options={sorts} value={sort} onChange={setSort} label="Sort blogs" />}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" />
                  <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-800" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="text-center text-sm text-gray-500">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-gray-500">
          {search.trim()
            ? 'No blogs match your search.'
            : sort === 'trending'
              ? trending.empty
              : 'No blogs have been created yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {incomplete && sort === 'newest' && (
            <p className="text-center text-xs text-gray-500">
              Newest among the first {DISCOVERY_SCAN_LIMIT.toLocaleString()} blogs found; there are more.
            </p>
          )}
          {filtered.map((blog) => (
            <BlogCard key={blog.id} blog={blog} currentUserId={viewerId} />
          ))}
        </div>
      )}

      {cursor && !loading && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={() => { loadMore().catch(() => {}) }} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load more blogs'}
          </Button>
        </div>
      )}
    </div>
  )
}

function BlogCard({ blog, currentUserId }: { blog: BlogWithUsername; currentUserId?: string }) {
  const { isFollowing, isLoading: followLoading, toggleFollow } = useBlogFollow(blog.id, undefined, false)
  const isOwnBlog = currentUserId === blog.ownerId

  const handleFollowClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    toggleFollow().catch(() => {})
  }

  return (
    <Link href={getBlogUrl(blog.id)} className="block">
      <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 transition hover:border-gray-300 dark:border-gray-800 dark:bg-neutral-950 dark:hover:border-gray-600">
        {blog.avatar ? (
          <IpfsImage
            src={blog.avatar}
            alt={blog.name}
            className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-yappr-500 to-yappr-700 text-sm font-bold text-white">
            {blog.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-gray-900 dark:text-white">
            {blog.name}
          </h3>
          {blog.username && (
            <p className="text-xs text-yappr-400">@{blog.username}</p>
          )}
          {blog.description && (
            <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
              {blog.description}
            </p>
          )}
        </div>
        {!isOwnBlog && (
          <button
            type="button"
            onClick={handleFollowClick}
            disabled={followLoading}
            className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
              isFollowing
                ? 'border border-gray-600 text-gray-300 hover:border-red-500 hover:text-red-400'
                : 'bg-yappr-500 text-white hover:bg-yappr-600'
            }`}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </button>
        )}
      </div>
    </Link>
  )
}
