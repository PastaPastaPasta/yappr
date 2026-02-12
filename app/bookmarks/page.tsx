'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  BookmarkIcon,
  MagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  ShareIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { PostCard } from '@/components/post/post-card'
import { ComposeModal } from '@/components/compose/compose-modal'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import toast from 'react-hot-toast'
import { useSettingsStore } from '@/lib/store'

interface BookmarkedPost {
  id: string
  content: string
  author: {
    id: string
    username: string
    handle: string
    displayName: string
    avatar: string
    followers: number
    following: number
    verified?: boolean
    joinedAt: Date
  }
  createdAt: Date
  timestamp: string
  likes: number
  replies: number
  reposts: number
  views: number
  bookmarkedAt: Date
}

function BookmarksPage() {
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [bookmarks, setBookmarks] = useState<BookmarkedPost[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<'recent' | 'oldest'>('recent')

  useEffect(() => {
    const loadBookmarks = async () => {
      if (!user) return

      setIsLoading(true)
      try {
        const { bookmarkService } = await import('@/lib/services/bookmark-service')
        const { postService } = await import('@/lib/services/post-service')

        // Get bookmark documents
        const bookmarkDocs = await bookmarkService.getUserBookmarks(user.identityId)

        // Fetch raw post data for each bookmark (without individual enrichment)
        const rawPostsWithBookmarkData = await Promise.all(
          bookmarkDocs.map(async (bookmark) => {
            const post = await postService.get(bookmark.postId)
            if (!post) return null
            return {
              post,
              bookmarkedAt: new Date(bookmark.$createdAt)
            }
          })
        )

        // Filter out deleted posts
        const validPostsWithData = rawPostsWithBookmarkData.filter(
          (item): item is NonNullable<typeof item> => item !== null
        )

        // Batch enrich all posts at once (efficient DPNS resolution)
        const postsToEnrich = validPostsWithData.map(item => item.post)
        const enrichedPosts = await postService.enrichPostsBatch(postsToEnrich)

        // Combine enriched posts with bookmark data
        const postsWithBookmarkData = validPostsWithData.map((item, index) => ({
          ...enrichedPosts[index],
          bookmarkedAt: item.bookmarkedAt
        }))

        // Filter out any remaining invalid posts and set bookmarks
        setBookmarks(postsWithBookmarkData.filter((p): p is BookmarkedPost => p !== null))
      } catch (error) {
        console.error('Error loading bookmarks:', error)
        toast.error('Failed to load bookmarks')
      } finally {
        setIsLoading(false)
      }
    }

    loadBookmarks().catch(err => console.error('Failed to load bookmarks:', err))
  }, [user])

  const removeBookmark = async (postId: string) => {
    if (!user) return

    // Optimistic update
    const previousBookmarks = bookmarks
    setBookmarks(prev => prev.filter(post => post.id !== postId))

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const success = await bookmarkService.removeBookmark(postId, user.identityId)
      if (success) {
        toast.success('Removed from bookmarks')
      } else {
        // Rollback on failure
        setBookmarks(previousBookmarks)
        toast.error('Failed to remove bookmark')
      }
    } catch (error) {
      console.error('Error removing bookmark:', error)
      setBookmarks(previousBookmarks)
      toast.error('Failed to remove bookmark')
    }
  }

  const clearAllBookmarks = async () => {
    if (!user) return
    if (!confirm('Are you sure you want to clear all bookmarks?')) return

    const previousBookmarks = bookmarks
    setBookmarks([])

    try {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')

      // Remove all bookmarks
      const results = await Promise.all(
        previousBookmarks.map(post =>
          bookmarkService.removeBookmark(post.id, user.identityId)
        )
      )

      const allSucceeded = results.every(r => r)
      if (allSucceeded) {
        toast.success('All bookmarks cleared')
      } else {
        // Some failed, reload to get current state
        toast.error('Some bookmarks could not be removed')
      }
    } catch (error) {
      console.error('Error clearing bookmarks:', error)
      setBookmarks(previousBookmarks)
      toast.error('Failed to clear bookmarks')
    }
  }

  const filteredBookmarks = bookmarks
    .filter(post => 
      post.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.author.username.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      const timeA = a.bookmarkedAt.getTime()
      const timeB = b.bookmarkedAt.getTime()
      return sortBy === 'recent' ? timeB - timeA : timeA - timeB
    })

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 border-b border-gray-200 dark:border-gray-800 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <h1 className="text-xl font-bold">Bookmarks</h1>
              <p className="text-sm text-gray-500">{bookmarks.length} saved posts</p>
            </div>
            
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
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
                    onClick={() => setSortBy(sortBy === 'recent' ? 'oldest' : 'recent')}
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
                  >
                    <TrashIcon className="h-4 w-4" />
                    Clear all bookmarks
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          
          {bookmarks.length > 0 && (
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
        </header>

        {isLoading ? (
          <div className="p-8 text-center">
            <Spinner size="md" className="mx-auto mb-4" />
            <p className="text-gray-500">Loading bookmarks...</p>
          </div>
        ) : bookmarks.length === 0 ? (
          <div className="p-8 text-center">
            <BookmarkIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Save posts for later</h2>
            <p className="text-gray-500 text-sm">
              Don&apos;t let the good ones fly away! Bookmark posts to easily find them again.
            </p>
          </div>
        ) : filteredBookmarks.length === 0 ? (
          <div className="p-8 text-center">
            <MagnifyingGlassIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No bookmarks found matching &quot;{searchQuery}&quot;</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {filteredBookmarks.map((post) => (
              <motion.div
                key={post.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="relative group"
              >
                <PostCard post={post} />
                
                {/* Bookmark Options Overlay */}
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className={`p-2 bg-white/90 dark:bg-neutral-900/90 rounded-full shadow-lg hover:bg-gray-100 dark:hover:bg-gray-900 ${potatoMode ? '' : 'backdrop-blur-sm'}`}>
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
                            navigator.clipboard.writeText(`${window.location.origin}/post?id=${post.id}`)
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
                        >
                          <BookmarkIcon className="h-4 w-4" />
                          Remove bookmark
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </motion.div>
            ))}
          </div>
        )}
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}

export default withAuth(BookmarksPage)