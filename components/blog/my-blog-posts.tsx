'use client'

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { blogPostService } from '@/lib/services'
import type { BlogPost } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { reportModerationRefusal } from '@/components/moderation/barred-writer-notice'

/** Parent-independent author management, including posts from deleted blogs. */
export function MyBlogPosts({ ownerId }: { ownerId: string }) {
  const [posts, setPosts] = useState<BlogPost[]>([])
  const [cursor, setCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [deleting, setDeleting] = useState<BlogPost | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    setPosts([])
    setCursor(undefined)
    blogPostService.getOwnerPostsPage(ownerId).then((page) => {
      if (!cancelled) {
        setPosts(page.posts)
        setCursor(page.nextCursor)
      }
    }).catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ownerId, refreshVersion])

  const loadMore = async () => {
    setLoading(true)
    setError(false)
    try {
      const page = await blogPostService.getOwnerPostsPage(ownerId, { startAfter: cursor })
      setPosts((previous) => [...previous, ...page.posts])
      setCursor(page.nextCursor)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const retract = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      if (!await blogPostService.deletePost(deleting.id, ownerId)) throw new Error('Delete refused')
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

  return (
    <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
      <h2 className="text-lg font-semibold">My posts</h2>
      <p className="text-sm text-gray-500">Your posts stay here after you delete a blog. Deleting a post removes its text and closes its comments.</p>
      {posts.map((post) => (
        <div key={post.id} className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm">{post.title}</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setDeleting(post)}>Delete post</Button>
        </div>
      ))}
      {loading && <p className="text-sm text-gray-500">Loading posts...</p>}
      {!loading && !error && posts.length === 0 && <p className="text-sm text-gray-500">No posts.</p>}
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
