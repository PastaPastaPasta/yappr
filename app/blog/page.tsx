'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { dpnsService } from '@/lib/services/dpns-service'
import { normalizeDpnsUsername } from '@/lib/post-helpers'
import { blogService, blogPostService } from '@/lib/services'
import type { Blog, BlogPost } from '@/lib/types'
import { BlogDiscovery } from '@/components/blog/blog-discovery'
import { MyBlogsList } from '@/components/blog/my-blogs-list'
import { BlogSettings } from '@/components/blog/blog-settings'
import { ComposePost } from '@/components/blog/compose-post'
import { BlogHome } from '@/components/blog/blog-home'
import { BlogPostView } from '@/components/blog/blog-post-view'
import { ThemeEditor } from '@/components/blog/theme-editor'
import { ComposeModal } from '@/components/compose/compose-modal'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getBlogPostUrl } from '@/lib/blog/content-utils'
import type { BlogThemeConfig } from '@/lib/blog/theme-types'
import toast from 'react-hot-toast'

function BlogPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { isReady: sdkReady } = useSdk()

  const blogIdParam = searchParams.get('blog')
  const postSlugParam = searchParams.get('post')

  const [selectedBlog, setSelectedBlog] = useState<Blog | null>(null)
  const [ownerPosts, setOwnerPosts] = useState<BlogPost[]>([])
  const [editingPost, setEditingPost] = useState<BlogPost | null>(null)
  const [activeTab, setActiveTab] = useState<'posts' | 'compose' | 'settings' | 'theme'>('posts')

  const [viewBlog, setViewBlog] = useState<Blog | null>(null)
  const [viewPost, setViewPost] = useState<BlogPost | null>(null)
  const [viewUsername, setViewUsername] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(blogIdParam))
  const [error, setError] = useState<string | null>(null)

  const isViewMode = Boolean(blogIdParam)

  useEffect(() => {
    if (!sdkReady) return

    let cancelled = false

    const load = async () => {
      if (!blogIdParam) {
        if (cancelled) return
        setViewBlog(null)
        setViewPost(null)
        setViewUsername(null)
        setError(null)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const blog = await blogService.getBlog(blogIdParam)
        if (!blog) {
          if (cancelled) return
          setError('Blog not found')
          return
        }

        // Resolve username and post in parallel — both depend only on the blog
        const [resolved, post] = await Promise.all([
          dpnsService.resolveUsername(blog.ownerId).catch(() => null),
          postSlugParam
            ? blogPostService.getPostBySlug(blog.id, postSlugParam)
            : Promise.resolve(null),
        ])

        if (cancelled) return
        setViewBlog(blog)
        setViewUsername(resolved ? normalizeDpnsUsername(resolved) : null)

        if (postSlugParam && !post) {
          setError('Post not found')
          setViewPost(null)
          return
        }
        setViewPost(post)
      } catch {
        if (cancelled) return
        setError('Failed to load blog')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setLoading(false)
        setError('Failed to load blog')
      }
    })

    return () => {
      cancelled = true
    }
  }, [sdkReady, blogIdParam, postSlugParam])

  useEffect(() => {
    let cancelled = false

    if (!selectedBlog || !user?.identityId) return

    const loadPosts = async () => {
      const posts = await blogPostService.getPostsByBlog(selectedBlog.id, { limit: 100 })
      if (cancelled) return
      setOwnerPosts(posts)
    }

    loadPosts().catch(() => {
      if (!cancelled) {
        setOwnerPosts([])
      }
    })

    return () => {
      cancelled = true
    }
  }, [selectedBlog, user?.identityId])

  const deselectBlog = () => {
    setSelectedBlog(null)
    setEditingPost(null)
    setActiveTab('posts')
  }

  const navigateToPosts = () => {
    setEditingPost(null)
    setActiveTab('posts')
  }

  const refreshPosts = async () => {
    if (!selectedBlog) return
    const posts = await blogPostService.getPostsByBlog(selectedBlog.id, { limit: 100 })
    setOwnerPosts(posts)
  }

  const handleThemeSave = async (themeConfig: BlogThemeConfig) => {
    if (!selectedBlog || !user?.identityId) return
    try {
      const updated = await blogService.updateBlog(selectedBlog.id, user.identityId, {
        themeConfig,
      })
      toast.success('Theme updated')
      setSelectedBlog(updated)
    } catch {
      toast.error('Failed to update theme')
    }
  }

  const isComposeMode = !isViewMode && selectedBlog !== null && activeTab === 'compose' && !editingPost
  const isWideMode = !isViewMode && selectedBlog !== null && (activeTab === 'theme' || isComposeMode)

  const renderCenter = () => {
    if (loading) {
      return <p className="p-6 text-sm text-gray-500">Loading blog...</p>
    }

    if (isViewMode) {
      if (error) {
        return <p className="p-6 text-sm text-gray-500">{error}</p>
      }
      if (!viewBlog) {
        return <p className="p-6 text-sm text-gray-500">Blog not found.</p>
      }

      if (viewPost) {
        return <BlogPostView blog={viewBlog} post={viewPost} username={viewUsername || ''} />
      }

      return <BlogHome blog={viewBlog} username={viewUsername || ''} />
    }

    if (!selectedBlog) {
      return (
        <div className="p-4">
          {user && (
            <MyBlogsList
              ownerId={user?.identityId}
              onSelectBlog={(blog) => {
                setSelectedBlog(blog)
                setEditingPost(null)
                setActiveTab('posts')
              }}
            />
          )}
          <BlogDiscovery sdkReady={sdkReady} showHeader={!user} />
        </div>
      )
    }

    if (!user) return null

    const tabs: { key: typeof activeTab; label: string }[] = [
      { key: 'posts', label: `Posts (${ownerPosts.length})` },
      { key: 'compose', label: editingPost ? 'Edit Post' : 'New Post' },
      { key: 'settings', label: 'Settings' },
      { key: 'theme', label: 'Theme' },
    ]

    return (
      <div>
        {/* Blog dashboard header — hidden during focused compose */}
        {!isComposeMode && (
          <div className="border-b border-gray-800/60 px-5 pb-0 pt-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold text-white">{selectedBlog.name}</h1>
                {selectedBlog.description && (
                  <p className="mt-0.5 truncate text-sm text-gray-500">{selectedBlog.description}</p>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 rounded-full bg-gray-800/60 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-300"
                onClick={deselectBlog}
              >
                All Blogs
              </button>
            </div>

            <nav className="flex gap-1" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'relative px-4 py-2.5 text-sm font-medium transition-colors',
                    activeTab === tab.key
                      ? 'text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  )}
                >
                  {tab.label}
                  {activeTab === tab.key && (
                    <div className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-yappr-500" />
                  )}
                </button>
              ))}
            </nav>
          </div>
        )}

        {/* Tab content */}
        <div className={isComposeMode ? '' : 'p-5'}>
          {activeTab === 'posts' && (
            <section>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  {ownerPosts.length === 0 ? 'No posts yet' : `${ownerPosts.length} post${ownerPosts.length !== 1 ? 's' : ''}`}
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingPost(null)
                    setActiveTab('compose')
                  }}
                >
                  New Post
                </Button>
              </div>

              {ownerPosts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-800 py-12 text-center">
                  <p className="text-sm text-gray-500">Start writing your first post.</p>
                  <button
                    type="button"
                    className="mt-3 text-sm font-medium text-yappr-400 transition-colors hover:text-yappr-300"
                    onClick={() => {
                      setEditingPost(null)
                      setActiveTab('compose')
                    }}
                  >
                    Create a post
                  </button>
                </div>
              ) : (
                <div className="divide-y divide-gray-800/60">
                  {ownerPosts.map((post) => {
                    const isPublished = post.publishedAt !== undefined
                    return (
                      <div key={post.id} className="group flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => router.push(getBlogPostUrl(post.blogId, post.slug))}
                        >
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium text-gray-100 group-hover:text-white transition-colors">{post.title}</p>
                            <span className={cn(
                              'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                              isPublished
                                ? 'bg-green-500/10 text-green-400'
                                : 'bg-amber-500/10 text-amber-400'
                            )}>
                              {isPublished ? 'Published' : 'Draft'}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-xs text-gray-500">{post.createdAt.toLocaleDateString()}</span>
                            {post.labels && (
                              <span className="text-xs text-gray-600">{post.labels}</span>
                            )}
                          </div>
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded-full px-3 py-1 text-xs text-gray-500 transition-all group-hover:bg-gray-800/60 group-hover:text-gray-300"
                          onClick={() => {
                            setEditingPost(post)
                            setActiveTab('compose')
                          }}
                        >
                          Edit
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {activeTab === 'compose' && (
            <ComposePost
              key={editingPost?.id ?? 'new'}
              blog={selectedBlog}
              onBack={navigateToPosts}
              editPost={editingPost ?? undefined}
              ownerId={editingPost ? user.identityId : undefined}
              onPublished={(post) => {
                if (editingPost) {
                  navigateToPosts()
                  refreshPosts().catch(() => {})
                } else {
                  setOwnerPosts((prev) => [post, ...prev])
                  setActiveTab('posts')
                }
              }}
            />
          )}

          {activeTab === 'settings' && (
            <BlogSettings
              blog={selectedBlog}
              ownerId={user.identityId}
              onUpdated={(updated) => setSelectedBlog(updated)}
            />
          )}

          {activeTab === 'theme' && (
            <ThemeEditor
              key={`${selectedBlog.id}:${selectedBlog.$revision || 0}`}
              initialThemeConfig={selectedBlog.themeConfig}
              blogName={selectedBlog.name}
              blogDescription={selectedBlog.description}
              onSave={handleThemeSave}
            />
          )}
        </div>
      </div>
    )
  }

  if (isViewMode) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-950 transition-colors">
        <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-neutral-950/80">
          <div className="mx-auto flex items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
            <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors">
              <ArrowLeftIcon className="h-4 w-4" />
              Posts
            </button>
            <Link href="/" className="text-sm font-bold text-gray-900 dark:text-white">
              Yappr
            </Link>
          </div>
        </nav>
        <main className="mx-auto px-4 py-6 sm:px-6 lg:px-8">
          {renderCenter()}
        </main>
        <ComposeModal />
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className={cn(
          "w-full border-gray-200 dark:border-gray-800",
          isWideMode ? "max-w-[1100px]" : "max-w-[700px] md:border-x"
        )}>
          {!isComposeMode && (
            <header className="sticky top-[32px] sm:top-[40px] z-40 border-b border-gray-200 bg-white/80 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-neutral-900/80">
              <h1 className="text-xl font-bold">Blog</h1>
            </header>
          )}
          {renderCenter()}
        </main>
      </div>
      {!isWideMode && <RightSidebar />}
      <ComposeModal />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-gray-500">Loading blog...</p>
    </div>
  )
}

function BlogPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <BlogPageContent />
    </Suspense>
  )
}

export default withAuth(BlogPage, { optional: true })
