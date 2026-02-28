'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { blogPostService } from '@/lib/services'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'

interface BlogHomeProps {
  blog: Blog
  username: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => extractText(block))
      .filter(Boolean)
      .join(' ')
  }
  if (content && typeof content === 'object') {
    return Object.values(content as Record<string, unknown>)
      .map((value) => extractText(value))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

export function BlogHome({ blog, username }: BlogHomeProps) {
  const [posts, setPosts] = useState<BlogPost[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const pageSize = 10

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const result = await blogPostService.getPostsByBlog(blog.id, { limit: 100 })
        setPosts(result)
      } finally {
        setLoading(false)
      }
    }

    load().catch(() => setLoading(false))
  }, [blog.id])

  const pagedPosts = useMemo(() => posts.slice(0, page * pageSize), [page, posts])
  const hasMore = pagedPosts.length < posts.length

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-neutral-950">
        {blog.headerImage ? (
          <IpfsImage src={blog.headerImage} alt={`${blog.name} header`} className="h-44 w-full object-cover" />
        ) : (
          <div className="h-44 w-full bg-gradient-to-r from-yappr-900/30 via-gray-900 to-yappr-700/30" />
        )}

        <div className="p-4">
          <div className="mb-2 flex items-center gap-3">
            {blog.avatar ? (
              <IpfsImage src={blog.avatar} alt={`${blog.name} avatar`} className="h-12 w-12 rounded-full object-cover" />
            ) : (
              <div className="h-12 w-12 rounded-full bg-gray-800" />
            )}
            <div>
              <h1 className="text-2xl font-bold">{blog.name}</h1>
              <p className="text-sm text-gray-500">@{username}</p>
            </div>
          </div>
          {blog.description && <p className="text-gray-300">{blog.description}</p>}
        </div>
      </section>

      {loading ? (
        <p className="text-sm text-gray-500">Loading posts...</p>
      ) : pagedPosts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-gray-500">No posts yet.</div>
      ) : (
        <div className="space-y-3">
          {pagedPosts.map((post) => {
            const excerpt = extractText(post.content).slice(0, 200)
            const href = `/blog?user=${encodeURIComponent(username)}&post=${encodeURIComponent(post.slug)}`

            return (
              <Link key={post.id} href={href} className="block rounded-xl border border-gray-800 bg-neutral-950 p-4 hover:border-gray-700">
                {post.coverImage && (
                  <IpfsImage src={post.coverImage} alt={post.title} className="mb-3 h-44 w-full rounded-lg object-cover" />
                )}
                <h3 className="text-lg font-semibold">{post.title}</h3>
                {post.subtitle && <p className="text-sm text-gray-400">{post.subtitle}</p>}
                {excerpt && <p className="mt-2 text-sm text-gray-500">{excerpt}{excerpt.length >= 200 ? '...' : ''}</p>}
                <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                  <span>{post.createdAt.toLocaleDateString()}</span>
                  {post.labels && <span>• {post.labels}</span>}
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setPage((prev) => prev + 1)}
            className="rounded-full border border-gray-700 px-4 py-2 text-sm hover:bg-gray-900"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  )
}
