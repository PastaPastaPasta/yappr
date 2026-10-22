'use client'

import { useDeletedBlogs } from '@/lib/blog/deleted-blogs'
import { useEffect, useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { blogService, blogPostService } from '@/lib/services'
import type { Blog } from '@/lib/types'
import { blogIsV9 } from '@/lib/constants'
import { MyBlogPosts } from './my-blog-posts'
import { isBlogPostTombstone } from '@/lib/blog/content-utils'
import { CreateBlogModal } from './create-blog-modal'
import { ModerationLabel } from '@/components/moderation/moderation-label'

interface MyBlogsListProps {
  ownerId: string
  onSelectBlog?: (blog: Blog) => void
}

export function MyBlogsList({ ownerId, onSelectBlog }: MyBlogsListProps) {
  const deletedIds = useDeletedBlogs((state) => state.ids)
  const [blogs, setBlogs] = useState<Blog[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openCreate, setOpenCreate] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await blogService.getBlogsByOwner(ownerId, { includeHidden: true })
        if (cancelled) return
        setBlogs(result)

        const pages = await blogPostService.getPostsByBlogs(result.map(blog => blog.id), 100)
        // A deleted post (a v7 tombstone) is not one of the blog's posts any more.
        const countEntries = result.map(blog => [blog.id, pages.get(blog.id)?.filter(post => !isBlogPostTombstone(post)).length ?? 0])
        if (cancelled) return

        setCounts(Object.fromEntries(countEntries))
      } catch {
        if (!cancelled) setError('Failed to load blogs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load().catch(() => {})

    return () => { cancelled = true }
  }, [ownerId])

  const visibleBlogs = useMemo(() => blogs.filter((blog) => !deletedIds.has(blog.id)), [blogs, deletedIds])
  const liveBlogIds = useMemo(() => new Set(visibleBlogs.map((blog) => blog.id)), [visibleBlogs])

  return (
    <div className="mb-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">My blogs</h2>
        <Button onClick={() => setOpenCreate(true)}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Create Blog
        </Button>
      </div>

      {/* Nothing while loading: most people have no blog, so a placeholder would only collapse. */}
      {loading ? null : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : visibleBlogs.length === 0 ? null : (
        <div className="space-y-3">
          {visibleBlogs.map((blog) => (
            <div key={blog.id}>
              <button
                onClick={() => onSelectBlog?.(blog)}
                className="w-full rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-gray-300 dark:border-gray-800 dark:bg-neutral-950 dark:hover:border-gray-700"
              >
                <p className="text-lg font-semibold">{blog.name}</p>
                {blog.description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{blog.description}</p>}
                <p className="mt-2 text-xs text-gray-500">{counts[blog.id] || 0} posts</p>
              </button>
              <ModerationLabel contract="blog" moderation={blog.moderation} className="mt-2" />
            </div>
          ))}
        </div>
      )}

      {blogIsV9() && !loading && !error && <MyBlogPosts key={ownerId} ownerId={ownerId} liveBlogIds={liveBlogIds} />}

      <CreateBlogModal
        open={openCreate}
        onOpenChange={setOpenCreate}
        onCreated={(created) => {
          setBlogs((prev) => [created, ...prev])
          setCounts((prev) => ({ ...prev, [created.id]: 0 }))
        }}
      />
    </div>
  )
}
