'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { dpnsService } from '@/lib/services/dpns-service'
import { blogService, blogPostService } from '@/lib/services'
import type { Blog, BlogPost } from '@/lib/types'
import { BlogDiscovery } from '@/components/blog/blog-discovery'
import { MyBlogsList } from '@/components/blog/my-blogs-list'
import { BlogSettings } from '@/components/blog/blog-settings'
import { ComposePost } from '@/components/blog/compose-post'
import { EditPost } from '@/components/blog/edit-post'
import { BlogHome } from '@/components/blog/blog-home'
import { BlogPostView } from '@/components/blog/blog-post-view'
import { ThemeEditor } from '@/components/blog/theme-editor'
import { ComposeModal } from '@/components/compose/compose-modal'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

function BlogPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()

  const usernameParam = searchParams.get('user')
  const postSlugParam = searchParams.get('post')

  const [selectedBlog, setSelectedBlog] = useState<Blog | null>(null)
  const [ownerPosts, setOwnerPosts] = useState<BlogPost[]>([])
  const [editingPostId, setEditingPostId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'posts' | 'compose' | 'settings' | 'theme'>('posts')
  const [isSavingTheme, setIsSavingTheme] = useState(false)

  const [viewBlog, setViewBlog] = useState<Blog | null>(null)
  const [viewPost, setViewPost] = useState<BlogPost | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (!usernameParam) {
        if (cancelled) return
        setViewBlog(null)
        setViewPost(null)
        setError(null)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const ownerId = await dpnsService.resolveIdentity(usernameParam)
        if (!ownerId) {
          if (cancelled) return
          setError('User not found')
          return
        }

        const blogs = await blogService.getBlogsByOwner(ownerId)
        const primaryBlog = blogs[0]
        if (!primaryBlog) {
          if (cancelled) return
          setError('No blog found for this user')
          return
        }

        if (cancelled) return
        setViewBlog(primaryBlog)

        if (postSlugParam) {
          const post = await blogPostService.getPostBySlug(primaryBlog.id, postSlugParam)
          if (!post) {
            if (cancelled) return
            setError('Post not found')
            setViewPost(null)
            return
          }
          if (cancelled) return
          setViewPost(post)
        } else {
          if (cancelled) return
          setViewPost(null)
        }
      } catch {
        if (cancelled) return
        setError('Failed to load blog')
      } finally {
        if (cancelled) return
        setLoading(false)
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
  }, [postSlugParam, usernameParam])

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

  const renderCenter = () => {
    if (loading) {
      return <p className="p-6 text-sm text-gray-500">Loading blog...</p>
    }

    if (usernameParam) {
      if (error) {
        return <p className="p-6 text-sm text-gray-500">{error}</p>
      }
      if (!viewBlog) {
        return <p className="p-6 text-sm text-gray-500">Blog not found.</p>
      }

      if (viewPost) {
        return <BlogPostView blog={viewBlog} post={viewPost} username={usernameParam} />
      }

      return <BlogHome blog={viewBlog} username={usernameParam} />
    }

    if (!user) {
      return <BlogDiscovery />
    }

    if (!selectedBlog) {
      return (
        <div className="p-4">
          <MyBlogsList
            ownerId={user.identityId}
            onSelectBlog={(blog) => {
              setSelectedBlog(blog)
              setEditingPostId(null)
            }}
          />
        </div>
      )
    }

    const handleThemeSave = async (themeConfig: string) => {
      setIsSavingTheme(true)
      try {
        const updated = await blogService.updateBlog(selectedBlog.id, user.identityId, {
          themeConfig,
        })
        toast.success('Theme updated')
        setSelectedBlog(updated)
      } catch {
        toast.error('Failed to update theme')
      } finally {
        setIsSavingTheme(false)
      }
    }

    const refreshPosts = async () => {
      const posts = await blogPostService.getPostsByBlog(selectedBlog.id, { limit: 100 })
      setOwnerPosts(posts)
    }

    const tabs: { key: typeof activeTab; label: string }[] = [
      { key: 'posts', label: `Posts (${ownerPosts.length})` },
      { key: 'compose', label: editingPostId ? 'Edit Post' : 'New Post' },
      { key: 'settings', label: 'Settings' },
      { key: 'theme', label: 'Theme' },
    ]

    return (
      <div className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{selectedBlog.name}</h1>
          <button
            type="button"
            className="text-sm text-yappr-400 hover:underline"
            onClick={() => {
              setSelectedBlog(null)
              setEditingPostId(null)
              setActiveTab('posts')
            }}
          >
            Back to My Blogs
          </button>
        </div>

        <div className="flex border-b border-gray-200 dark:border-gray-800">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex-1 py-4 text-center font-medium transition-colors relative',
                activeTab === tab.key
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
              )}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {activeTab === 'posts' && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-semibold">Posts</h3>
                <button
                  type="button"
                  className="rounded-lg bg-yappr-500 px-4 py-2 text-sm font-medium text-white hover:bg-yappr-600 transition-colors"
                  onClick={() => {
                    setEditingPostId(null)
                    setActiveTab('compose')
                  }}
                >
                  New Post
                </button>
              </div>
              {ownerPosts.length === 0 ? (
                <p className="text-sm text-gray-500">No posts yet.</p>
              ) : (
                <div className="space-y-2">
                  {ownerPosts.map((post) => (
                    <div key={post.id} className="flex items-center justify-between rounded-lg border border-gray-800 p-3">
                      <button
                        type="button"
                        className="text-left min-w-0 flex-1"
                        onClick={() => router.push(`/blog?user=${encodeURIComponent(user.dpnsUsername || '')}&post=${encodeURIComponent(post.slug)}`)}
                      >
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{post.title}</p>
                          <span className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                            post.publishedAt !== undefined
                              ? 'bg-green-900/50 text-green-400'
                              : 'bg-yellow-900/50 text-yellow-400'
                          )}>
                            {post.publishedAt !== undefined ? 'Published' : 'Draft'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500">{post.createdAt.toLocaleDateString()}</p>
                        {post.labels && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {post.labels.split(',').map((label) => (
                              <span key={label} className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                                {label.trim()}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                      <button
                        type="button"
                        className="ml-3 shrink-0 text-sm text-yappr-400 hover:underline"
                        onClick={() => {
                          setEditingPostId(post.id)
                          setActiveTab('compose')
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeTab === 'compose' && (
            <div>
              <button
                type="button"
                className="mb-3 text-sm text-yappr-400 hover:underline"
                onClick={() => {
                  setEditingPostId(null)
                  setActiveTab('posts')
                }}
              >
                &larr; Back to posts
              </button>
              {editingPostId ? (
                <EditPost
                  postId={editingPostId}
                  ownerId={user.identityId}
                  onSaved={() => {
                    setEditingPostId(null)
                    setActiveTab('posts')
                    refreshPosts().catch(() => {})
                  }}
                />
              ) : (
                <ComposePost
                  blog={selectedBlog}
                  onPublished={(post) => {
                    setOwnerPosts((prev) => [post, ...prev])
                    setActiveTab('posts')
                  }}
                />
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <BlogSettings
              blog={selectedBlog}
              ownerId={user.identityId}
              username={user.dpnsUsername || undefined}
              onUpdated={(updated) => setSelectedBlog(updated)}
            />
          )}

          {activeTab === 'theme' && (
            <div className={isSavingTheme ? 'opacity-75 pointer-events-none' : ''}>
              <ThemeEditor
                key={`${selectedBlog.id}:${selectedBlog.themeConfig || 'default'}`}
                initialThemeConfig={selectedBlog.themeConfig}
                blogName={selectedBlog.name}
                blogDescription={selectedBlog.description}
                onSave={handleThemeSave}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  if (usernameParam) {
    return (
      <div className="min-h-screen bg-neutral-950">
        <nav className="sticky top-0 z-50 border-b border-gray-800 bg-neutral-950/80 backdrop-blur-xl">
          <div className="mx-auto grid max-w-5xl grid-cols-3 items-center px-4 py-3 sm:px-6 lg:px-8">
            <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors">
              <ArrowLeftIcon className="h-4 w-4" />
              Back to Yappr
            </Link>
            <Link href="/" className="justify-self-center text-sm font-bold text-white">
              Yappr
            </Link>
            <div />
          </div>
        </nav>
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
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
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className="sticky top-[32px] sm:top-[40px] z-40 border-b border-gray-200 bg-white/80 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-neutral-900/80">
            <h1 className="text-xl font-bold">Blog</h1>
          </header>
          {renderCenter()}
        </main>
      </div>
      <RightSidebar />
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
