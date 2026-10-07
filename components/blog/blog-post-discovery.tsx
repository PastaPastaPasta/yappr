'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { blogPostService } from '@/lib/services'
import { blogStatsService } from '@/lib/services/blog-stats-service'
import { enrichBlogPostsWithBlogNames, getBlogPostUrl, isPublishedBlogPost } from '@/lib/blog/content-utils'
import type { BlogPost, BlogPostWithAuthor } from '@/lib/types'
import { useCursorList, type CursorPage } from '@/hooks/use-cursor-list'
import { BlogPostCard } from './blog-post-card'
import { PillTabs } from './pill-tabs'
import { Button } from '@/components/ui/button'

/**
 * Posts across every blog (blog v7): `latest` pages `blogPost.timeline`
 * newest first; `discussed` is one proved ranking on `discussedRecent`, the
 * posts with the most comments over the contract's ~3-day window.
 */
const SORTS = [
  { key: 'latest', label: 'Latest posts' },
  { key: 'discussed', label: 'Most discussed (3 days)' },
] as const

type PostSort = (typeof SORTS)[number]['key']

const PAGE_SIZE = 20
/** Timeline pages read in one go while drafts and tombstones leave a page with nothing to show. */
const MAX_PAGES_PER_LOAD = 3
const DISCUSSED_LIMIT = 50

/** A post to list; on the `discussed` list it carries its proved comment count over the window. */
type RankedPost = BlogPost & { recentComments?: number }
type ListedPost = RankedPost & BlogPostWithAuthor

/** The next published posts on the timeline after `cursor`, reading on past pages that show nothing. */
async function latestPage(cursor?: string): Promise<{ posts: RankedPost[]; nextCursor?: string }> {
  const posts: BlogPost[] = []
  let nextCursor = cursor
  for (let pages = 0; pages < MAX_PAGES_PER_LOAD; pages++) {
    const page = await blogPostService.getLatestPosts({ limit: PAGE_SIZE, startAfter: nextCursor })
    posts.push(...page.posts)
    nextCursor = page.nextCursor
    if (posts.length > 0 || !nextCursor) break
  }
  return { posts, nextCursor }
}

/** The ranked posts in the proved order, with their counts; drafts, tombstones and missing posts dropped. */
async function discussedPosts(): Promise<RankedPost[]> {
  const ranked = await blogStatsService.mostDiscussedPosts(DISCUSSED_LIMIT)
  if (ranked.length === 0) return []
  const byId = new Map((await blogPostService.getMany(ranked.map((entry) => entry.id))).map((post) => [post.id, post]))
  return ranked.flatMap((entry) => {
    const post = byId.get(entry.id)
    return post && isPublishedBlogPost(post) ? [{ ...post, recentComments: entry.count }] : []
  })
}

export function BlogPostDiscovery({ sdkReady = true }: { sdkReady?: boolean }) {
  const router = useRouter()
  const [sort, setSort] = useState<PostSort>('latest')
  const loadPage = useCallback(async (cursor?: string): Promise<CursorPage<ListedPost>> => {
    const page = sort === 'latest' ? await latestPage(cursor) : { posts: await discussedPosts(), nextCursor: undefined }
    return { items: await enrichBlogPostsWithBlogNames(page.posts), nextCursor: page.nextCursor }
  }, [sort])
  const { items: posts, cursor, loading, loadingMore, error, loadMore } = useCursorList(loadPage, {
    enabled: sdkReady, loadError: 'Failed to load posts', moreError: 'Failed to load more posts',
  })

  const openPost = (post: BlogPostWithAuthor) => router.push(getBlogPostUrl(post.blogId, post.slug))

  return (
    <div className="space-y-4">
      <PillTabs options={SORTS} value={sort} onChange={setSort} label="Sort posts" />

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-gray-200 bg-gray-100 dark:border-gray-800 dark:bg-gray-900" />
          ))}
        </div>
      ) : error ? (
        <p className="text-center text-sm text-gray-500">{error}</p>
      ) : posts.length === 0 ? (
        <p className="text-center text-sm text-gray-500">
          {sort === 'discussed'
            ? 'No post was commented on in the last 3 days.'
            : cursor
              ? 'Nothing published in the newest posts read so far.'
              : 'No posts have been published yet.'}
        </p>
      ) : (
        <div className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {posts.map((post, index) => (
            <div key={post.id} className="relative">
              <BlogPostCard post={post} onClick={openPost} index={index} />
              {post.recentComments !== undefined && (
                <span className="pointer-events-none absolute right-4 top-4 text-xs text-gray-500">
                  {post.recentComments} {post.recentComments === 1 ? 'comment' : 'comments'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {cursor && !loading && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={() => { loadMore().catch(() => {}) }} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
