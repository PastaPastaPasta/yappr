'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { dpnsService } from '@/lib/services/dpns-service'
import { blogService, blogPostService } from '@/lib/services'
import type { Blog, BlogPost } from '@/lib/types'
import { MyBlogsList } from '@/components/blog/my-blogs-list'
import { BlogSettings } from '@/components/blog/blog-settings'
import { ComposePost } from '@/components/blog/compose-post'
import { EditPost } from '@/components/blog/edit-post'
import { BlogHome } from '@/components/blog/blog-home'
import { BlogPostView } from '@/components/blog/blog-post-view'

function BlogPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()

  const usernameParam = searchParams.get('user')
  const postSlugParam = searchParams.get('post')

  const [selectedBlog, setSelectedBlog] = useState<Blog | null>(null)
  const [ownerPosts, setOwnerPosts] = useState<BlogPost[]>([])
  const [editingPostId, setEditingPostId] = useState<string | null>(null)

  const [viewBlog, setViewBlog] = useState<Blog | null>(null)
  const [viewPost, setViewPost] = useState<BlogPost | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      if (!usernameParam) {
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
          setError('User not found')
          return
        }

        const blogs = await blogService.getBlogsByOwner(ownerId)
        const primaryBlog = blogs[0]
        if (!primaryBlog) {
          setError('No blog found for this user')
          return
        }

        setViewBlog(primaryBlog)

        if (postSlugParam) {
          const post = await blogPostService.getPostBySlug(primaryBlog.id, postSlugParam)
          if (!post) {
            setError('Post not found')
            setViewPost(null)
            return
          }
          setViewPost(post)
        } else {
          setViewPost(null)
        }
      } catch {
        setError('Failed to load blog')
      } finally {
        setLoading(false)
      }
    }

    load().catch(() => {
      setLoading(false)
      setError('Failed to load blog')
    })
  }, [postSlugParam, usernameParam])

  useEffect(() => {
    if (!selectedBlog || !user?.identityId) return

    const loadPosts = async () => {
      const posts = await blogPostService.getPostsByBlog(selectedBlog.id, { limit: 100 })
      setOwnerPosts(posts)
    }

    loadPosts().catch(() => setOwnerPosts([]))
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
        return (
          <div className="p-4">
            <BlogPostView blog={viewBlog} post={viewPost} username={usernameParam} />
          </div>
        )
      }

      return (
        <div className="p-4">
          <BlogHome blog={viewBlog} username={usernameParam} />
        </div>
      )
    }

    if (!user) {
      return (
        <div className="p-8 text-center">
          <h1 className="text-2xl font-bold">Yappr Blog</h1>
          <p className="mt-2 text-gray-400">Publish long-form posts with IPFS media and BlockNote editing.</p>
        </div>
      )
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

    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{selectedBlog.name}</h1>
          <button
            type="button"
            className="text-sm text-yappr-400 hover:underline"
            onClick={() => {
              setSelectedBlog(null)
              setEditingPostId(null)
            }}
          >
            Back to My Blogs
          </button>
        </div>

        <BlogSettings
          blog={selectedBlog}
          ownerId={user.identityId}
          username={user.dpnsUsername || undefined}
          onUpdated={(updated) => setSelectedBlog(updated)}
        />

        {editingPostId ? (
          <EditPost
            postId={editingPostId}
            ownerId={user.identityId}
            onSaved={async () => {
              setEditingPostId(null)
              const posts = await blogPostService.getPostsByBlog(selectedBlog.id, { limit: 100 })
              setOwnerPosts(posts)
            }}
          />
        ) : (
          <ComposePost
            blog={selectedBlog}
            onPublished={(post) => {
              setOwnerPosts((prev) => [post, ...prev])
            }}
          />
        )}

        <section className="rounded-xl border border-gray-800 bg-neutral-950 p-4">
          <h3 className="mb-3 text-lg font-semibold">Posts</h3>
          {ownerPosts.length === 0 ? (
            <p className="text-sm text-gray-500">No posts yet.</p>
          ) : (
            <div className="space-y-2">
              {ownerPosts.map((post) => (
                <div key={post.id} className="flex items-center justify-between rounded-lg border border-gray-800 p-3">
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => router.push(`/blog?user=${encodeURIComponent(user.dpnsUsername || '')}&post=${encodeURIComponent(post.slug)}`)}
                  >
                    <p className="font-medium">{post.title}</p>
                    <p className="text-xs text-gray-500">{post.createdAt.toLocaleDateString()}</p>
                  </button>
                  <button
                    type="button"
                    className="text-sm text-yappr-400 hover:underline"
                    onClick={() => setEditingPostId(post.id)}
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
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
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <p className="p-6 text-sm text-gray-500">Loading blog...</p>
        </main>
      </div>
      <RightSidebar />
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
