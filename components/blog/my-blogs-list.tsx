'use client'

import { useEffect, useState } from 'react'
import { PlusIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { blogService, blogPostService } from '@/lib/services'
import type { Blog } from '@/lib/types'
import { CreateBlogModal } from './create-blog-modal'

interface MyBlogsListProps {
  ownerId: string
  onSelectBlog?: (blog: Blog) => void
}

export function MyBlogsList({ ownerId, onSelectBlog }: MyBlogsListProps) {
  const [blogs, setBlogs] = useState<Blog[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [openCreate, setOpenCreate] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const result = await blogService.getBlogsByOwner(ownerId)
        setBlogs(result)

        const settled = await Promise.allSettled(result.map(async (blog) => {
          const posts = await blogPostService.getPostsByBlog(blog.id, { limit: 100 })
          return [blog.id, posts.length] as const
        }))
        const countEntries = settled
          .filter((r): r is PromiseFulfilledResult<readonly [string, number]> => r.status === 'fulfilled')
          .map((r) => r.value)

        setCounts(Object.fromEntries(countEntries))
      } finally {
        setLoading(false)
      }
    }

    load().catch(() => setLoading(false))
  }, [ownerId])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">My Blogs</h2>
        <Button onClick={() => setOpenCreate(true)}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Create Blog
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading blogs...</p>
      ) : blogs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 p-6 text-center text-gray-400">
          No blogs yet. Create your first blog.
        </div>
      ) : (
        <div className="space-y-3">
          {blogs.map((blog) => (
            <button
              key={blog.id}
              onClick={() => onSelectBlog?.(blog)}
              className="w-full rounded-xl border border-gray-800 bg-neutral-950 p-4 text-left hover:border-gray-700"
            >
              <p className="text-lg font-semibold">{blog.name}</p>
              {blog.description && <p className="mt-1 text-sm text-gray-400">{blog.description}</p>}
              <p className="mt-2 text-xs text-gray-500">{counts[blog.id] || 0} posts</p>
            </button>
          ))}
        </div>
      )}

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
