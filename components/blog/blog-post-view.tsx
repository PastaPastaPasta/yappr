'use client'

import Link from 'next/link'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogViewer } from './blog-viewer'

interface BlogPostViewProps {
  blog: Blog
  post: BlogPost
  username: string
}

export function BlogPostView({ blog, post, username }: BlogPostViewProps) {
  const blocks = Array.isArray(post.content) ? post.content : []

  return (
    <article className="space-y-4 rounded-xl border border-gray-800 bg-neutral-950 p-5">
      <Link href={`/blog?user=${encodeURIComponent(username)}`} className="text-sm text-yappr-400 hover:underline">
        ← Back to blog
      </Link>

      {post.coverImage && (
        <IpfsImage src={post.coverImage} alt={post.title} className="h-64 w-full rounded-xl object-cover" />
      )}

      <header>
        <h1 className="text-3xl font-bold">{post.title}</h1>
        {post.subtitle && <p className="mt-1 text-lg text-gray-400">{post.subtitle}</p>}
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <span>{post.createdAt.toLocaleDateString()}</span>
          <span>•</span>
          <span>{blog.name}</span>
          {post.labels && (
            <>
              <span>•</span>
              <span>{post.labels}</span>
            </>
          )}
        </div>
      </header>

      <BlogViewer blocks={blocks} />
    </article>
  )
}
