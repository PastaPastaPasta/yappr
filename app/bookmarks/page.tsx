'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  BookmarkIcon,
  MagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  ShareIcon,
  TrashIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { PageShell, PageHeader } from '@/components/layout/page-shell'
import { PostCard } from '@/components/post/post-card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import toast from 'react-hot-toast'
import { useSettingsStore } from '@/lib/store'
import { isHiddenTombstone } from '@/lib/feed/hidden-tombstones'
import { canBookmark } from '@/lib/contract-topology'
import type { BookmarkDocument } from '@/lib/services/bookmark-service'
import type { Post } from '@/lib/types'
import { useHydratedPages } from '@/hooks/use-hydrated-pages'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'

/** Bookmarked posts fetched and enriched per page. */
const PAGE_SIZE = 30

interface SavedPost {
  id: string
  post?: Post
}
const UNAVAILABLE_POST = 'This post is no longer available.'

/** One row per saved post, including unavailable targets, in bookmark order. */
async function hydrateBookmarks(bookmarkDocs: BookmarkDocument[]): Promise<SavedPost[]> {
  const { postService, replyToPost } = await import('@/lib/services/post-service')
  const page = await postService.getPostsByIdsForDisplay(bookmarkDocs.map(bookmark => bookmark.postId), { throwOnError: true })
  const postsById = new Map(page.posts.map(post => [post.id, post]))
  const missingIds = bookmarkDocs.map(bookmark => bookmark.postId).filter(id => !postsById.has(id))
  if (missingIds.length > 0 && canBookmark('reply')) {
    const { replyService } = await import('@/lib/services/reply-service')
    const replies = await replyService.getMany(missingIds, { throwOnError: true })
    for (const reply of replies) postsById.set(reply.id, replyToPost(reply))
  }
  const kept = bookmarkDocs.flatMap((bookmark) => {
    const post = postsById.get(bookmark.postId)
    // Deleted posts drop out; v11: so does a post its author tombstoned.
    return post && !isHiddenTombstone(post) ? [post] : []
  })
  // enrichPostsBatch also resolves quote targets, so bookmarked quotes
  // render their embed instead of a permanent skeleton
  const enriched = await postService.enrichPostsBatch(kept, page.preloaded)
  const enrichedById = new Map(enriched.map(post => [post.id, post]))
  return bookmarkDocs.map(bookmark => ({ id: bookmark.postId, post: enrichedById.get(bookmark.postId) }))
}

function BookmarksPage() {
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [isMutating, setIsMutating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<'recent' | 'oldest'>('recent')
  const list = useHydratedPages(hydrateBookmarks, PAGE_SIZE)
  const { reset: resetList, drop: dropFromList } = list
  const bookmarks = list.pages?.items ?? []
  const bookmarkCount = list.pages?.keys.length ?? 0
  const scroll = useInfiniteScroll({
    hasMore: list.hasMore,
    isLoading: list.loadingMore,
    onLoadMore: list.loadMore,
    resetKey: sortBy,
  })

  // Every bookmark (no cap), newest first; posts load a page at a time.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const loadBookmarks = async () => {
      setIsLoading(true)
      setLoadFailed(false)
      setSortBy('recent')
      try {
        const { bookmarkService } = await import('@/lib/services/bookmark-service')
        const docs = await bookmarkService.getUserBookmarks(user.identityId)
        if (!cancelled) await resetList(docs)
      } catch (error) {
        logger.error('Error loading bookmarks:', error)
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadBookmarks().catch(err => logger.error('Failed to load bookmarks:', err))
    return () => { cancelled = true }
  }, [user, resetList, reload])

  // The sort orders the whole (current) list, so a change starts the pages over.
  const toggleSort = () => {
    const keys = list.pages?.keys
    setSortBy(sortBy === 'recent' ? 'oldest' : 'recent')
    if (!keys) return
    setIsLoading(true)
    resetList([...keys].reverse())
      .catch((error) => {
        logger.error('Error loading bookmarks:', error)
        toast.error('Failed to load bookmarks')
      })
      .finally(() => setIsLoading(false))
  }

  const dropBookmarks = useCallback((postIds: Set<string>) => {
    dropFromList(doc => !postIds.has(doc.postId), post => !postIds.has(post.id))
  }, [dropFromList])

  const removeBookmark = async (postId: string) => {
    if (!user || isMutating) return
    setIsMutating(true)

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const success = await bookmarkService.removeBookmark(postId, user.identityId)
      if (success) {
        dropBookmarks(new Set([postId]))
        toast.success('Removed from bookmarks')
      } else {
        toast.error('Failed to remove bookmark')
      }
    } catch (error) {
      logger.error('Error removing bookmark:', error)
      toast.error('Failed to remove bookmark')
    } finally {
      setIsMutating(false)
    }
  }

  const clearAllBookmarks = async () => {
    if (!user || isMutating) return
    if (!confirm('Are you sure you want to clear all bookmarks?')) return

    // Every bookmark, including those not scrolled to yet, deleted by id.
    const docs = list.pages?.keys ?? []
    setIsMutating(true)

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const { mapLimit } = await import('@/lib/services/pagination-utils')
      const deleted = await mapLimit(docs, 4, doc => bookmarkService.deleteBookmark(doc.$id, user.identityId))

      const removedIds = new Set(docs.filter((_, index) => deleted[index]).map(doc => doc.postId))
      dropBookmarks(removedIds)
      if (deleted.every(Boolean)) {
        toast.success('All bookmarks cleared')
      } else {
        toast.error('Some bookmarks could not be removed')
      }
    } catch (error) {
      logger.error('Error clearing bookmarks:', error)
      toast.error('Failed to clear bookmarks')
    } finally {
      setIsMutating(false)
    }
  }

  // Search covers the bookmarks loaded so far; the list keeps loading as it scrolls.
  const query = searchQuery.toLowerCase()
  const filteredBookmarks = bookmarks.filter(({ post }) =>
    post ? post.content.toLowerCase().includes(query) || post.author.username.toLowerCase().includes(query)
      : !query || UNAVAILABLE_POST.toLowerCase().includes(query)
  )

  return (
    <PageShell>
        <PageHeader>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <h1 className="text-xl font-bold">Bookmarks</h1>
              <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-gray-500">
                <span>{bookmarkCount} saved {bookmarkCount === 1 ? 'post' : 'posts'}</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1" data-testid="bookmarks-public-note">
                  <GlobeAltIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Anyone can see your bookmarks
                </span>
              </p>
            </div>
            
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label="Bookmarks options"
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500 focus-visible:ring-offset-2"
                >
                  <EllipsisHorizontalIcon className="h-5 w-5" />
                </button>
              </DropdownMenu.Trigger>
              
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[200px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                  sideOffset={5}
                >
                  <DropdownMenu.Item
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2"
                    onClick={toggleSort}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                    Sort by {sortBy === 'recent' ? 'oldest' : 'most recent'}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
                  <DropdownMenu.Item
                    className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2 text-red-600"
                    onClick={clearAllBookmarks}
                    disabled={isMutating}
                  >
                    <TrashIcon className="h-4 w-4" />
                    Clear all bookmarks
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          
          {bookmarkCount > 0 && (
            <div className="px-4 pb-3">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <Input
                  type="text"
                  placeholder="Search bookmarks"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          )}
        </PageHeader>

        {isLoading ? (
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading bookmarks...</p>
          </div>
        ) : loadFailed ? (
          <div role="alert" className="p-8 text-center">
            <p>Bookmarks could not be loaded. Please try again.</p>
            <button type="button" className="mt-3 text-yappr-600 hover:underline" onClick={() => setReload(value => value + 1)}>Retry</button>
          </div>
        ) : bookmarks.length === 0 && !list.hasMore ? (
          <div className="p-8 text-center">
            <BookmarkIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Save posts for later</h2>
            <p className="text-gray-500 text-sm">
              Don&apos;t let the good ones fly away! Bookmark posts to easily find them again.
            </p>
          </div>
        ) : filteredBookmarks.length === 0 && !list.hasMore ? (
          <div className="p-8 text-center">
            <MagnifyingGlassIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No bookmarks found matching &quot;{searchQuery}&quot;</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {filteredBookmarks.map(({ id, post }) => post ? (
              <motion.div
                key={post.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="relative group"
              >
                <PostCard
                  post={post}
                  keepIfUnreadable
                  bookmarkAction={{ active: true, loading: isMutating, onClick: () => removeBookmark(post.id) }}
                />
                
                {/* Bookmark Options Overlay */}
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        aria-label="Bookmark options"
                        className={`p-2 bg-white/90 dark:bg-neutral-900/90 rounded-full shadow-lg hover:bg-gray-100 dark:hover:bg-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500 focus-visible:ring-offset-2 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
                      >
                        <EllipsisHorizontalIcon className="h-5 w-5" />
                      </button>
                    </DropdownMenu.Trigger>
                    
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="min-w-[180px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                        sideOffset={5}
                      >
                        <DropdownMenu.Item
                          className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH || ''}/post/?id=${post.id}`)
                              .then(() => toast.success('Link copied to clipboard'))
                              .catch(() => toast.error('Failed to copy link'))
                          }}
                        >
                          <ShareIcon className="h-4 w-4" />
                          Share post
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
                        <DropdownMenu.Item
                          className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2 text-red-600"
                          onClick={() => removeBookmark(post.id)}
                          disabled={isMutating}
                        >
                          <BookmarkIcon className="h-4 w-4" />
                          Remove bookmark
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </motion.div>
            ) : (
              <div key={id} className="flex items-center justify-between gap-4 p-4">
                <p className="text-sm text-gray-500">{UNAVAILABLE_POST}</p>
                <button type="button" disabled={isMutating} onClick={() => removeBookmark(id)}
                  className="shrink-0 text-sm text-yappr-600 hover:underline">Remove bookmark</button>
              </div>
            ))}
            {list.hasMore && (
              <InfiniteScrollSentinel
                sentinelRef={scroll.sentinelRef}
                isLoading={list.loadingMore}
                isSuspended={scroll.isSuspended}
                onLoadMore={scroll.loadMore}
                label="Load more bookmarks"
              />
            )}
          </div>
        )}
    </PageShell>
  )
}

export default withAuth(BookmarksPage)
