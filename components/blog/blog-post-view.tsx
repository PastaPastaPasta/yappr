'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChatBubbleLeftIcon,
  EllipsisHorizontalIcon,
  HeartIcon,
  BookmarkIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'
import { useTheme } from 'next-themes'
import toast from 'react-hot-toast'
import type { Blog, BlogPost } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { UserAvatar } from '@/components/ui/avatar-image'
import { BlogViewer } from './blog-viewer'
import { BlogThemeProvider } from './theme-provider'
import { BlogComments } from './blog-comments'
import { EmbedPreview } from './embed-preview'
import { decodeSummary, estimateReadingTime, getBlogPostUrl } from '@/lib/blog/content-utils'
import { getReaderOverrideStyle, getReaderFontSize, getAppThemeForReadingMode } from '@/lib/blog/reader-preferences'
import { normalizeBlogThemeConfig } from '@/lib/blog/theme-types'
import { ReadingPreferencesPopover } from './reading-preferences'
import { useAppStore, useReaderPreferencesStore } from '@/lib/store'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useAuth } from '@/contexts/auth-context'
import { useBlogFollow } from '@/hooks/use-blog-follow'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { APP_URL } from '@/lib/constants'

const X_ICON_PATH = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'

const DROPDOWN_ITEM_CLASS = 'flex items-center gap-2 px-4 py-2 text-sm outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800'
const SIDEBAR_BUTTON_CLASS = 'group rounded-full p-2 transition hover:bg-black/5 dark:hover:bg-white/10'

interface BlogPostViewProps {
  blog: Blog
  post: BlogPost
  username: string
}

function BlogAvatar({ blog, size }: { blog: Blog; size: 'sm' | 'md' }) {
  const sizeClass = size === 'md' ? 'h-10 w-10' : 'h-8 w-8'

  if (blog.avatar) {
    return (
      <IpfsImage
        src={blog.avatar}
        alt={blog.name}
        className={`${sizeClass} shrink-0 rounded-full object-cover`}
      />
    )
  }

  return <UserAvatar userId={blog.ownerId} alt={blog.name} size={size} className="shrink-0" />
}

export function BlogPostView({ blog, post, username }: BlogPostViewProps) {
  const blocks = Array.isArray(post.content) ? post.content : []
  const { text: summaryText, hidden: summaryHidden } = decodeSummary(post.subtitle)
  const { setQuotingPost, setComposeOpen } = useAppStore()
  const { requireAuth } = useRequireAuth()
  const { user } = useAuth()
  const { isFollowing, isLoading: followLoading, toggleFollow } = useBlogFollow(blog.id)
  const isOwnBlog = user?.identityId === blog.ownerId
  const showFollowCta = user && !isOwnBlog && !isFollowing && !followLoading
  const [commentCount, setCommentCount] = useState(0)
  const { readingMode, fontSize } = useReaderPreferencesStore()
  const readerOverrides = useMemo(() => getReaderOverrideStyle(readingMode), [readingMode])
  const contentFontSize = getReaderFontSize(fontSize)
  const { theme, setTheme } = useTheme()
  const savedThemeRef = useRef<string | undefined>(undefined)
  const commentsRef = useRef<HTMLDivElement>(null)
  const authorBg = useMemo(
    () => normalizeBlogThemeConfig(blog.themeConfig).colors.bg,
    [blog.themeConfig],
  )
  const relativeTime = useRelativeTime(post.createdAt)

  // Sync reading mode → app theme so nav/comments/buttons match
  useEffect(() => {
    if (!savedThemeRef.current && theme !== undefined) {
      savedThemeRef.current = theme
    }
    setTheme(getAppThemeForReadingMode(readingMode, authorBg))
  }, [readingMode, authorBg, setTheme, theme])

  // Restore original theme on unmount
  useEffect(() => {
    return () => {
      if (savedThemeRef.current) setTheme(savedThemeRef.current)
    }
  }, [setTheme])

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
      content: summaryText || post.title,
      createdAt: post.createdAt,
      likes: 0,
      reposts: 0,
      replies: 0,
      views: 0,
      __isBlogPostQuote: true,
      title: post.title,
      subtitle: summaryText || undefined,
      slug: post.slug,
      coverImage: post.coverImage,
      blogId: blog.id,
      blogName: blog.name,
      blogUsername: username,
      blogContent: post.content,
    })

    setComposeOpen(true)
  }

  const postUrl = `${APP_URL}${getBlogPostUrl(blog.id, post.slug)}`

  const handleCopyLink = () => {
    navigator.clipboard.writeText(postUrl).then(
      () => toast.success('Link copied to clipboard'),
      () => toast.error('Failed to copy link')
    )
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

  const scrollToComments = () => {
    commentsRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <BlogThemeProvider
      themeConfig={blog.themeConfig}
      blogName={blog.name}
      blogDescription={blog.description}
      username={username}
      headerImage={blog.headerImage}
      labels={blog.labels}
      readerOverrides={readerOverrides}
      contentFontSize={contentFontSize}
      hideHeader
      hideOuterChrome
    >
      <div className="relative">
        {/* Main article column */}
        <article className="mx-auto max-w-[680px]">
          <h1
            className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl"
            style={{ color: 'var(--blog-heading)', fontFamily: 'var(--blog-heading-font)' }}
          >
            {post.title}
          </h1>

          {summaryText && !summaryHidden && (
            <p className="mt-2 text-lg" style={{ color: 'var(--blog-text)', opacity: 0.7 }}>
              {summaryText}
            </p>
          )}

          <p className="mt-4 text-sm" style={{ color: 'var(--blog-text)', opacity: 0.6 }}>
            {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
          </p>

          {/* Author row */}
          <div className="mt-4 flex items-center gap-3">
            <BlogAvatar blog={blog} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" style={{ color: 'var(--blog-heading)' }}>
                {blog.name}
              </p>
              <p className="truncate text-xs" style={{ color: 'var(--blog-text)', opacity: 0.6 }}>
                @{username} · {relativeTime}
              </p>
            </div>
            {!isOwnBlog && user && (
              <button
                type="button"
                onClick={toggleFollow}
                disabled={followLoading}
                className="shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition"
                style={
                  isFollowing
                    ? { color: 'var(--blog-link)', border: '1px solid var(--blog-border)' }
                    : { backgroundColor: 'var(--blog-link)', color: '#fff' }
                }
              >
                {isFollowing ? 'Following' : 'Follow'}
              </button>
            )}
          </div>

          {/* Meta / action row */}
          <div
            className="mt-4 flex items-center justify-between gap-3 border-y py-2.5"
            style={{ borderColor: 'var(--blog-border)' }}
          >
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--blog-text)', opacity: 0.6 }}>
              <span>{readingTime} min read</span>
              {post.labels && (
                <>
                  <span>·</span>
                  <span>{post.labels}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ReadingPreferencesPopover />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="rounded-full p-1.5 transition hover:bg-black/5 dark:hover:bg-white/10"
                    aria-label="More actions"
                  >
                    <EllipsisHorizontalIcon className="h-5 w-5" style={{ color: 'var(--blog-text)', opacity: 0.6 }} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="min-w-[180px] rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-neutral-900 z-50"
                    sideOffset={5}
                    align="end"
                  >
                    <DropdownMenu.Item onClick={handleQuote} className={DROPDOWN_ITEM_CLASS}>
                      Quote
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-gray-200 dark:bg-gray-800" />
                    <DropdownMenu.Item onClick={handleCopyLink} className={DROPDOWN_ITEM_CLASS}>
                      <LinkIcon className="h-4 w-4" />
                      Copy link
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onClick={handleShareX} className={DROPDOWN_ITEM_CLASS}>
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d={X_ICON_PATH} /></svg>
                      Share on X
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onClick={handleShareFacebook} className={DROPDOWN_ITEM_CLASS}>
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                      Share on Facebook
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onClick={handleShareReddit} className={DROPDOWN_ITEM_CLASS}>
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.066 13.06c.183.399.166.845-.044 1.225-.21.38-.578.648-1.003.733-.138.027-.276.04-.413.04-.745 0-1.424-.39-1.895-1.016A8.4 8.4 0 0 1 12 14.625a8.4 8.4 0 0 1-2.711-.583c-.471.626-1.15 1.016-1.895 1.016a1.7 1.7 0 0 1-.413-.04 1.5 1.5 0 0 1-1.003-.733 1.49 1.49 0 0 1-.044-1.225c.1-.216.241-.41.41-.574A3.4 3.4 0 0 1 6.06 11c0-2.93 2.664-5.313 5.94-5.313s5.94 2.383 5.94 5.313c0 .514-.104 1.008-.284 1.486.168.164.31.358.41.574zM9.5 12.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm5 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm-5.096 2.24c.628.628 1.638.882 2.596.882s1.968-.254 2.596-.882a.44.44 0 0 0-.62-.622c-.44.44-1.218.654-1.976.654s-1.536-.214-1.976-.654a.44.44 0 0 0-.62.622zM20.12 7.86c-.91 0-1.65.74-1.65 1.65 0 .21.04.41.11.6-.84-.55-1.79-.94-2.82-1.14l1.98-3.3.01-.02 2.82.68a1.32 1.32 0 0 0 1.3 1.1c.72 0 1.31-.59 1.31-1.31s-.59-1.31-1.31-1.31c-.52 0-.97.31-1.18.75l-2.58-.62a.44.44 0 0 0-.49.21L15.37 9c-1.08.17-2.1.56-2.97 1.14a1.64 1.64 0 0 0-1.65-1.59c-.91 0-1.65.74-1.65 1.65 0 .6.32 1.12.8 1.41a4.2 4.2 0 0 0-.21 1.39c0 3.23 3.29 5.86 7.31 5.86s7.31-2.63 7.31-5.86c0-.47-.07-.93-.21-1.36.47-.29.8-.82.8-1.41.02-.94-.72-1.68-1.63-1.68z" /></svg>
                      Share on Reddit
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-gray-200 dark:bg-gray-800" />
                    <EmbedPreview post={post} username={username} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>

          {/* Cover image */}
          {post.coverImage && (
            <div className="mt-6">
              <IpfsImage src={post.coverImage} alt={post.title} className="w-full rounded-2xl" />
            </div>
          )}

          {/* Article content */}
          <div className="mt-6">
            <BlogViewer blocks={blocks} />
          </div>

          {/* Follow CTA */}
          {showFollowCta && (
            <div className="mt-8 flex items-center gap-3 rounded-xl border p-4" style={{ borderColor: 'var(--blog-border)', backgroundColor: 'var(--blog-surface)' }}>
              <BlogAvatar blog={blog} size="sm" />
              <p className="flex-1 text-sm" style={{ color: 'var(--blog-text)' }}>
                Follow <strong style={{ color: 'var(--blog-heading)' }}>{blog.name}</strong> to get notified of new posts
              </p>
              <button
                type="button"
                onClick={toggleFollow}
                disabled={followLoading}
                className="rounded-full px-4 py-1.5 text-xs font-semibold text-white transition"
                style={{ backgroundColor: 'var(--blog-link)' }}
              >
                Follow
              </button>
            </div>
          )}

          {/* Comments */}
          <div ref={commentsRef} className="mt-8">
            <BlogComments
              blogPostId={post.id}
              blogPostOwnerId={post.ownerId}
              commentsEnabled={post.commentsEnabled !== false}
              onCommentCountChange={setCommentCount}
            />
          </div>
        </article>

        {/* Floating action sidebar -- xl+ only */}
        <aside className="absolute left-[calc(50%+370px)] top-0 hidden xl:block">
          <div className="sticky top-24 flex flex-col items-center gap-4">
            <button type="button" className={SIDEBAR_BUTTON_CLASS} aria-label="Like">
              <HeartIcon className="h-5 w-5 text-gray-400 transition group-hover:text-red-500" />
            </button>
            <button type="button" className={SIDEBAR_BUTTON_CLASS} aria-label="Jump to comments" onClick={scrollToComments}>
              <ChatBubbleLeftIcon className="h-5 w-5 text-gray-400 transition group-hover:text-blue-500" />
              {commentCount > 0 && (
                <span className="mt-0.5 block text-center text-[10px] text-gray-400">{commentCount}</span>
              )}
            </button>
            <button type="button" className={SIDEBAR_BUTTON_CLASS} aria-label="Bookmark">
              <BookmarkIcon className="h-5 w-5 text-gray-400 transition group-hover:text-yellow-500" />
            </button>
            <button type="button" className={SIDEBAR_BUTTON_CLASS} aria-label="Share on X" onClick={handleShareX}>
              <svg className="h-5 w-5 text-gray-400 transition group-hover:text-gray-700 dark:group-hover:text-white" viewBox="0 0 24 24" fill="currentColor"><path d={X_ICON_PATH} /></svg>
            </button>
          </div>
        </aside>
      </div>
    </BlogThemeProvider>
  )
}
