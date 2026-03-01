'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChatBubbleLeftIcon } from '@heroicons/react/24/outline'
import { blogCommentService, blogPostService } from '@/lib/services'
import { estimateReadingTime, extractText, parseLabels } from '@/lib/blog/content-utils'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogThemeProvider } from './theme-provider'

interface BlogHomeProps {
  blog: Blog
  username: string
}

export function BlogHome({ blog, username }: BlogHomeProps) {
  const [posts, setPosts] = useState<BlogPost[]>([])
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [activeLabel, setActiveLabel] = useState<string>('All')
  const pageSize = 10

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const result = await blogPostService.getPostsByBlog(blog.id, { limit: 100 })
        setPosts(result)

        const counts = await Promise.all(
          result.map(async (post) => {
            try {
              const comments = await blogCommentService.getCommentsByPost(post.id, { limit: 100 })
              return [post.id, comments.length] as const
            } catch {
              return [post.id, 0] as const
            }
          })
        )

        setCommentCounts(Object.fromEntries(counts))
      } finally {
        setLoading(false)
      }
    }

    load().catch(() => setLoading(false))
  }, [blog.id])

  const blogLabels = useMemo(() => parseLabels(blog.labels), [blog.labels])

  const filteredPosts = useMemo(() => {
    if (activeLabel === 'All') return posts
    return posts.filter((post) => parseLabels(post.labels).includes(activeLabel))
  }, [activeLabel, posts])

  const pagedPosts = useMemo(() => filteredPosts.slice(0, page * pageSize), [filteredPosts, page])
  const hasMore = pagedPosts.length < filteredPosts.length

  useEffect(() => {
    setPage(1)
  }, [activeLabel])

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
          {blog.avatar && (
            <IpfsImage src={blog.avatar} alt={`${blog.name} avatar`} className="h-9 w-9 rounded-full object-cover" />
          )}
          <span>{blog.labels || 'Publishing on Yappr'}</span>
        </div>
      )}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveLabel('All')}
          aria-pressed={activeLabel === 'All'}
          className={`rounded-full border px-3 py-1 text-xs transition ${
            activeLabel === 'All'
              ? 'border-[var(--blog-border)] bg-[var(--blog-surface)] text-[var(--blog-heading)]'
              : 'border-[var(--blog-border)] bg-transparent text-[var(--blog-text)]/80 hover:bg-[var(--blog-surface)]'
          }`}
        >
          All
        </button>
        {blogLabels.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => setActiveLabel(label)}
            aria-pressed={activeLabel === label}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              activeLabel === label
                ? 'border-[var(--blog-border)] bg-[var(--blog-surface)] text-[var(--blog-heading)]'
                : 'border-[var(--blog-border)] bg-transparent text-[var(--blog-text)]/80 hover:bg-[var(--blog-surface)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-[var(--blog-text)]/70">Loading posts...</p>
      ) : pagedPosts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--blog-border)] p-8 text-center text-[var(--blog-text)]/65">No posts yet.</div>
      ) : (
        <div className="space-y-3">
          {pagedPosts.map((post) => {
            const excerpt = extractText(post.content).slice(0, 200)
            const href = `/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(blog.id)}&post=${encodeURIComponent(post.slug)}`

            return (
              <Link key={post.id} href={href} className="block rounded-xl border border-[var(--blog-border)] bg-[var(--blog-surface)] p-4 transition hover:brightness-110">
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
                  <span>• {estimateReadingTime(post.content)} min read</span>
                  {post.labels && <span>• {post.labels}</span>}
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-[var(--blog-border)] px-2 py-0.5 text-[11px] text-[var(--blog-text)]/75">
                    <ChatBubbleLeftIcon className="h-3 w-3" />
                    {commentCounts[post.id] || 0}
                  </span>
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
            className="rounded-full border border-[var(--blog-border)] px-4 py-2 text-sm text-[var(--blog-text)] transition hover:bg-[var(--blog-surface)]"
          >
            Load more
          </button>
        </div>
      )}
    </BlogThemeProvider>
  )
}
