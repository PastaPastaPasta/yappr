'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChatBubbleLeftIcon } from '@heroicons/react/24/outline'
import { Clock3 } from 'lucide-react'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogViewer } from './blog-viewer'
import { BlogThemeProvider } from './theme-provider'
import { BlogComments } from './blog-comments'
import { EmbedPreview } from './embed-preview'
import { EditHistoryModal } from './edit-history-modal'
import { blogCommentService } from '@/lib/services'
import { generateArticleJsonLd, generateBlogPostMeta } from '@/lib/blog/seo-utils'
import { useAppStore } from '@/lib/store'
import { useAuth } from '@/contexts/auth-context'
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
  const { user } = useAuth()
  const [commentCount, setCommentCount] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const isAuthor = user?.identityId === post.ownerId
  const hasEdits = (post.$revision || 1) > 1 || Boolean(post.updatedAt && post.updatedAt.getTime() !== post.createdAt.getTime())

  useEffect(() => {
    const loadCommentCount = async () => {
      try {
        const comments = await blogCommentService.getCommentsByPost(post.id, { limit: 100 })
        setCommentCount(comments.length)
      } catch {
        setCommentCount(0)
      }
    }

    loadCommentCount()
  }, [post.id])

  useEffect(() => {
    const meta = generateBlogPostMeta(post, blog, username)
    const jsonLd = generateArticleJsonLd(post, blog, username)

    const touchedNodes: HTMLElement[] = []
    const originalMetaContent = new Map<HTMLMetaElement, string>()
    const originalScriptContent = new Map<HTMLScriptElement, string | null>()
    const ensureMeta = (selector: string, attr: 'name' | 'property', key: string, content: string) => {
      let node = document.head.querySelector<HTMLMetaElement>(selector)
      if (!node) {
        node = document.createElement('meta')
        node.setAttribute(attr, key)
        node.setAttribute('data-blog-seo', 'true')
        document.head.appendChild(node)
        touchedNodes.push(node)
      } else if (!originalMetaContent.has(node)) {
        originalMetaContent.set(node, node.content)
      }
      node.content = content
    }

    const prevTitle = document.title
    document.title = meta.title

    ensureMeta('meta[name="description"]', 'name', 'description', meta.description)
    ensureMeta('meta[property="og:title"]', 'property', 'og:title', meta.openGraph['og:title'])
    ensureMeta('meta[property="og:description"]', 'property', 'og:description', meta.openGraph['og:description'])
    ensureMeta('meta[property="og:image"]', 'property', 'og:image', meta.openGraph['og:image'])
    ensureMeta('meta[property="og:type"]', 'property', 'og:type', meta.openGraph['og:type'])
    ensureMeta('meta[property="og:url"]', 'property', 'og:url', meta.openGraph['og:url'])
    ensureMeta('meta[name="twitter:card"]', 'name', 'twitter:card', meta.twitter['twitter:card'])
    ensureMeta('meta[name="twitter:title"]', 'name', 'twitter:title', meta.twitter['twitter:title'])
    ensureMeta('meta[name="twitter:description"]', 'name', 'twitter:description', meta.twitter['twitter:description'])
    ensureMeta('meta[name="twitter:image"]', 'name', 'twitter:image', meta.twitter['twitter:image'])

    let script = document.head.querySelector<HTMLScriptElement>('script[data-blog-jsonld="true"]')
    if (!script) {
      script = document.createElement('script')
      script.type = 'application/ld+json'
      script.setAttribute('data-blog-jsonld', 'true')
      document.head.appendChild(script)
      touchedNodes.push(script)
    } else if (!originalScriptContent.has(script)) {
      originalScriptContent.set(script, script.textContent)
    }
    script.textContent = JSON.stringify(jsonLd)

    // For reliable crawler indexing, this SPA still needs pre-rendering or SSR proxying.
    return () => {
      document.title = prevTitle
      touchedNodes.forEach((node) => {
        if (node.parentNode) node.parentNode.removeChild(node)
      })
      originalMetaContent.forEach((value, node) => {
        node.content = value
      })
      originalScriptContent.forEach((value, node) => {
        node.textContent = value
      })
    }
  }, [blog, post, username])

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
      __isBlogPostQuote: true,
      title: post.title,
      subtitle: post.subtitle,
      slug: post.slug,
      coverImage: post.coverImage,
      blogId: blog.id,
      blogName: blog.name,
      blogUsername: username,
      blogContent: post.content,
    })

    setComposeOpen(true)
  }

  const postMeta = useMemo(() => (
    <div className="flex flex-wrap items-center gap-2">
      <span>{post.createdAt.toLocaleDateString()}</span>
      <span>•</span>
      <span>{blog.name}</span>
      {post.labels && (
        <>
          <span>•</span>
          <span>{post.labels}</span>
        </>
      )}
      <span>•</span>
      <span className="inline-flex items-center gap-1">
        <ChatBubbleLeftIcon className="h-4 w-4" />
        {commentCount}
      </span>
    </div>
  ), [blog.name, commentCount, post.createdAt, post.labels])

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
      meta={postMeta}
    >
      <article className="space-y-6">
        <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}>
          <Link href={`/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(blog.id)}`} className="text-sm hover:underline" style={{ color: 'var(--blog-link)' }}>
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
            {hasEdits && (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                style={{ color: 'var(--blog-link)' }}
              >
                <Clock3 className="h-4 w-4" />
                History
              </button>
            )}
            <EmbedPreview post={post} username={username} />
          </div>
        </div>

        {post.coverImage && (
          <IpfsImage src={post.coverImage} alt={post.title} className="h-72 w-full rounded-2xl object-cover sm:h-80 lg:h-96" />
        )}

        <BlogViewer blocks={blocks} />

        <BlogComments
          blogPostId={post.id}
          blogPostOwnerId={post.ownerId}
          commentsEnabled={post.commentsEnabled !== false}
        />
      </article>

      <EditHistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        post={post}
        isAuthor={Boolean(isAuthor)}
      />
    </BlogThemeProvider>
  )
}
