'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { blogPostService } from '@/lib/services'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogThemeProvider } from './theme-provider'

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
    <BlogThemeProvider
      themeConfig={blog.themeConfig}
      blogName={blog.name}
      blogDescription={blog.description}
      username={username}
      headerImage={blog.headerImage}
      labels={blog.labels}
      meta={(
        <div className="flex items-center gap-3">
          {blog.avatar ? (
            <IpfsImage src={blog.avatar} alt={`${blog.name} avatar`} className="h-9 w-9 rounded-full object-cover" />
          ) : (
            <div className="h-9 w-9 rounded-full bg-white/10" />
          )}
          <span>{blog.labels || 'Publishing on Yappr'}</span>
        </div>
      )}
    >
      {loading ? (
        <p className="text-sm text-[var(--blog-text)]/70">Loading posts...</p>
      ) : pagedPosts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-[var(--blog-text)]/65">No posts yet.</div>
      ) : (
        <div className="space-y-3">
          {pagedPosts.map((post) => {
            const excerpt = extractText(post.content).slice(0, 200)
            const href = `/blog?user=${encodeURIComponent(username)}&post=${encodeURIComponent(post.slug)}`

            return (
              <Link key={post.id} href={href} className="block rounded-xl border border-white/15 bg-black/20 p-4 transition hover:border-white/35">
                {post.coverImage && (
                  <IpfsImage src={post.coverImage} alt={post.title} className="mb-3 h-44 w-full rounded-lg object-cover" />
                )}
                <h3 className="text-lg font-semibold" style={{ color: 'var(--blog-heading)', fontFamily: 'var(--blog-heading-font)' }}>
                  {post.title}
                </h3>
                {post.subtitle && <p className="text-sm text-[var(--blog-text)]/80">{post.subtitle}</p>}
                {excerpt && <p className="mt-2 text-sm text-[var(--blog-text)]/75">{excerpt}{excerpt.length >= 200 ? '...' : ''}</p>}
                <div className="mt-2 flex items-center gap-2 text-xs text-[var(--blog-text)]/60">
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
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-[var(--blog-text)] transition hover:bg-white/10"
          >
            Load more
          </button>
        </div>
      )}
    </BlogThemeProvider>
  )
}
