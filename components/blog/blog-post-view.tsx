'use client'

import Link from 'next/link'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogViewer } from './blog-viewer'
import { BlogThemeProvider } from './theme-provider'
import { BlogComments } from './blog-comments'
import { EmbedPreview } from './embed-preview'
import { useAppStore } from '@/lib/store'
import { useRequireAuth } from '@/hooks/use-require-auth'

interface BlogPostViewProps {
  blog: Blog
  post: BlogPost
  username: string
}

export function BlogPostView({ blog, post, username }: BlogPostViewProps) {
  const blocks = Array.isArray(post.content) ? post.content : []
  const { setQuotingPost, setComposeOpen } = useAppStore()
  const { requireAuth } = useRequireAuth()

  const handleQuote = () => {
    if (!requireAuth('quote')) return

    setQuotingPost({
      id: post.id,
      author: {
        id: post.ownerId,
        username,
        displayName: blog.name,
        avatar: blog.avatar || '',
        followers: 0,
        following: 0,
        verified: false,
        joinedAt: new Date(0),
        hasDpns: true,
      },
      content: post.subtitle || post.title,
      createdAt: post.createdAt,
      likes: 0,
      reposts: 0,
      replies: 0,
      views: 0,
      ...( {
        __isBlogPostQuote: true,
        title: post.title,
        subtitle: post.subtitle,
        slug: post.slug,
        coverImage: post.coverImage,
        blogId: blog.id,
        blogName: blog.name,
        blogUsername: username,
        blogContent: post.content,
      } as Record<string, unknown>),
    })

    setComposeOpen(true)
  }

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
        <div className="flex items-center justify-between gap-3">
          <Link href={`/blog?user=${encodeURIComponent(username)}`} className="text-sm hover:underline" style={{ color: 'var(--blog-link)' }}>
            ← Back to blog
          </Link>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleQuote}
              className="text-sm font-medium hover:underline"
              style={{ color: 'var(--blog-link)' }}
            >
              Quote
            </button>
            <EmbedPreview post={post} username={username} />
          </div>
        </div>

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
