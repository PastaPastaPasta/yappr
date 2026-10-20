'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { blogPostService } from '@/lib/services'
import type { BlogPost } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { reportModerationRefusal } from '@/components/moderation/barred-writer-notice'

/** Pages read in one go while looking for a post from a deleted blog. */
const MAX_PAGES_PER_LOAD = 5

/** Reads pages from `startAfter` until one holds a post from a deleted blog, the posts run out, or the cap is hit. */
async function readUntilVisible(ownerId: string, startAfter: string | undefined, isLive: (blogId: string) => boolean) {
  const found: BlogPost[] = []
  let next = startAfter
  for (let page = 0; page < MAX_PAGES_PER_LOAD; page++) {
    const result = await blogPostService.getOwnerPostsPage(ownerId, next ? { startAfter: next } : undefined)
    found.push(...result.posts)
    next = result.nextCursor
    if (!next || result.posts.some((post) => !isLive(post.blogId))) break
  }
  return { posts: found, nextCursor: next }
}

/**
 * The author's posts whose blog is gone, so they can still be deleted. Posts in
 * `liveBlogIds` are managed from their blog's dashboard and are left out; the
 * section only appears once there is something to show.
 */
export function MyBlogPosts({ ownerId, liveBlogIds }: { ownerId: string; liveBlogIds?: ReadonlySet<string> }) {
  const [posts, setPosts] = useState<BlogPost[]>([])
  const [cursor, setCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // Set by a deletion: keep the section in place until the reload settles.
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState<BlogPost | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  // Read through a ref so a new set from the parent doesn't restart the load.
  const liveBlogIdsRef = useRef(liveBlogIds)
  useEffect(() => { liveBlogIdsRef.current = liveBlogIds }, [liveBlogIds])
  const isLive = useCallback((blogId: string) => liveBlogIdsRef.current?.has(blogId) ?? false, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    // The previous posts stay on screen until the new ones arrive.
    readUntilVisible(ownerId, undefined, isLive).then((result) => {
      if (!cancelled) {
        setPosts(result.posts)
        setCursor(result.nextCursor)
      }
    }).catch(() => { if (!cancelled) setError(true) })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => { cancelled = true }
  }, [ownerId, refreshVersion, isLive])

  const loadMore = async () => {
    setLoading(true)
    setError(false)
    try {
      const result = await readUntilVisible(ownerId, cursor, isLive)
      setPosts((previous) => [...previous, ...result.posts])
      setCursor(result.nextCursor)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const retract = async () => {
    if (!deleting) return
    const removed = deleting
    setBusy(true)
    try {
      if (!await blogPostService.deletePost(removed.id, ownerId)) throw new Error('Delete refused')
      setPosts((previous) => previous.filter((post) => post.id !== removed.id))
      setRefreshing(true)
      // A tombstone leaves the owner index, so its id can no longer be a paging cursor.
      setRefreshVersion((version) => version + 1)
      setDeleting(null)
      toast.success('Post deleted')
    } catch (failure) {
      if (!reportModerationRefusal(failure, ownerId, 'blog')) toast.error('Failed to delete the post. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const visiblePosts = liveBlogIds ? posts.filter((post) => !liveBlogIds.has(post.blogId)) : posts
  // Hidden only when there is truly nothing to reach: no post to show, no more
  // pages, no error to retry. Also while the very first read is out, so owners
  // with no such posts do not see the heading flash on every visit.
  const nothingToReach = visiblePosts.length === 0 && !cursor && !error && !loading && !refreshing
  const firstReadPending = loading && posts.length === 0 && !cursor && !error && !refreshing
  if (nothingToReach || firstReadPending) return null

  return (
    <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
      <h2 className="text-lg font-semibold">Posts from deleted blogs</h2>
      {visiblePosts.map((post) => (
        <div key={post.id} className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm">{post.title}</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setDeleting(post)}>Delete post</Button>
        </div>
      ))}
      {visiblePosts.length === 0 && cursor && !loading && !error && (
        <p className="text-sm text-gray-500">None among your most recent posts. Older ones may still be there.</p>
      )}
      {loading && <p className="text-sm text-gray-500">Loading posts...</p>}
      {error && <p role="alert" className="text-sm text-red-500">Could not load your posts.</p>}
      {!loading && (cursor || error) && <Button variant="outline" onClick={loadMore}>{error ? 'Try again' : 'Load more posts'}</Button>}
      <ConfirmDialog
        isOpen={deleting !== null}
        onClose={() => { if (!busy) setDeleting(null) }}
        onConfirm={retract}
        title="Delete post"
        message={`Delete “${deleting?.title ?? ''}”? Its text will be removed and comments will close. This cannot be undone.`}
        confirmText="Delete post"
        variant="danger"
        isLoading={busy}
      />
    </section>
  )
}
