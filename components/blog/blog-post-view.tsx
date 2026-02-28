'use client'

import Link from 'next/link'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogViewer } from './blog-viewer'
import { BlogThemeProvider } from './theme-provider'
import { BlogComments } from './blog-comments'

interface BlogPostViewProps {
  blog: Blog
  post: BlogPost
  username: string
}

export function BlogPostView({ blog, post, username }: BlogPostViewProps) {
  const blocks = Array.isArray(post.content) ? post.content : []

  return (
    <BlogThemeProvider
      themeConfig={blog.themeConfig}
      blogName={blog.name}
      blogDescription={blog.description}
      username={username}
      headerImage={blog.headerImage || post.coverImage}
      labels={blog.labels}
      title={post.title}
      subtitle={post.subtitle}
      meta={(
        <div className="flex items-center gap-2">
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
      )}
    >
      <article className="space-y-4">
        <Link href={`/blog?user=${encodeURIComponent(username)}`} className="text-sm hover:underline" style={{ color: 'var(--blog-link)' }}>
          ← Back to blog
        </Link>

        {post.coverImage && (
          <IpfsImage src={post.coverImage} alt={post.title} className="h-64 w-full rounded-xl object-cover" />
        )}

        <BlogViewer blocks={blocks} />

        <BlogComments
          blogPostId={post.id}
          blogPostOwnerId={post.ownerId}
          commentsEnabled={post.commentsEnabled !== false}
        />
      </article>
    </BlogThemeProvider>
  )
}
