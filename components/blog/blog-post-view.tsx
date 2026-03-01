'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChatBubbleLeftIcon, LinkIcon } from '@heroicons/react/24/outline'
import { Clock3 } from 'lucide-react'
import toast from 'react-hot-toast'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { BlogViewer } from './blog-viewer'
import { BlogThemeProvider } from './theme-provider'
import { BlogComments } from './blog-comments'
import { EmbedPreview } from './embed-preview'
import { EditHistoryModal } from './edit-history-modal'
import { blogCommentService } from '@/lib/services'
import { estimateReadingTime } from '@/lib/blog/content-utils'
import { useAppStore } from '@/lib/store'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { APP_URL } from '@/lib/constants'

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

    loadCommentCount().catch(() => setCommentCount(0))
  }, [post.id])

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

  const postUrl = `${APP_URL}/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(blog.id)}&post=${encodeURIComponent(post.slug)}`

  const handleCopyLink = () => {
    navigator.clipboard.writeText(postUrl).catch(() => {/* noop */})
    toast.success('Link copied to clipboard')
  }

  const handleShareX = () => {
    const text = `${post.title} by @${username}`
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(postUrl)}`, '_blank', 'noopener')
  }

  const handleShareFacebook = () => {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(postUrl)}`, '_blank', 'noopener')
  }

  const handleShareReddit = () => {
    window.open(`https://www.reddit.com/submit?url=${encodeURIComponent(postUrl)}&title=${encodeURIComponent(post.title)}`, '_blank', 'noopener')
  }

  const readingTime = useMemo(() => estimateReadingTime(post.content), [post.content])

  const postMeta = useMemo(() => (
    <div className="flex flex-wrap items-center gap-2">
      <span>{post.createdAt.toLocaleDateString()}</span>
      <span>•</span>
      <span>{blog.name}</span>
      <span>•</span>
      <span>{readingTime} min read</span>
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
  ), [blog.name, commentCount, post.createdAt, post.labels, readingTime])

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
        <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: 'var(--blog-border)' }}>
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
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                >
                  Share
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[180px] rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-neutral-900 z-50"
                  sideOffset={5}
                  align="end"
                >
                  <DropdownMenu.Item
                    onClick={handleCopyLink}
                    className="flex items-center gap-2 px-4 py-2 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <LinkIcon className="h-4 w-4" />
                    Copy link
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={handleShareX}
                    className="flex items-center gap-2 px-4 py-2 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                    Share on X
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={handleShareFacebook}
                    className="flex items-center gap-2 px-4 py-2 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                    Share on Facebook
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={handleShareReddit}
                    className="flex items-center gap-2 px-4 py-2 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.066 13.06c.183.399.166.845-.044 1.225-.21.38-.578.648-1.003.733-.138.027-.276.04-.413.04-.745 0-1.424-.39-1.895-1.016A8.4 8.4 0 0 1 12 14.625a8.4 8.4 0 0 1-2.711-.583c-.471.626-1.15 1.016-1.895 1.016a1.7 1.7 0 0 1-.413-.04 1.5 1.5 0 0 1-1.003-.733 1.49 1.49 0 0 1-.044-1.225c.1-.216.241-.41.41-.574A3.4 3.4 0 0 1 6.06 11c0-2.93 2.664-5.313 5.94-5.313s5.94 2.383 5.94 5.313c0 .514-.104 1.008-.284 1.486.168.164.31.358.41.574zM9.5 12.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm5 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm-5.096 2.24c.628.628 1.638.882 2.596.882s1.968-.254 2.596-.882a.44.44 0 0 0-.62-.622c-.44.44-1.218.654-1.976.654s-1.536-.214-1.976-.654a.44.44 0 0 0-.62.622zM20.12 7.86c-.91 0-1.65.74-1.65 1.65 0 .21.04.41.11.6-.84-.55-1.79-.94-2.82-1.14l1.98-3.3.01-.02 2.82.68a1.32 1.32 0 0 0 1.3 1.1c.72 0 1.31-.59 1.31-1.31s-.59-1.31-1.31-1.31c-.52 0-.97.31-1.18.75l-2.58-.62a.44.44 0 0 0-.49.21L15.37 9c-1.08.17-2.1.56-2.97 1.14a1.64 1.64 0 0 0-1.65-1.59c-.91 0-1.65.74-1.65 1.65 0 .6.32 1.12.8 1.41a4.2 4.2 0 0 0-.21 1.39c0 3.23 3.29 5.86 7.31 5.86s7.31-2.63 7.31-5.86c0-.47-.07-.93-.21-1.36.47-.29.8-.82.8-1.41.02-.94-.72-1.68-1.63-1.68z" /></svg>
                    Share on Reddit
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
