'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { blogPostService } from '@/lib/services'
import { dpnsService } from '@/lib/services/dpns-service'
import type { BlogPost } from '@/lib/types'
import { EMBED_STYLES } from '@/lib/embed/embed-styles'
import { renderEmbedHtml } from '@/lib/embed/embed-renderer'
import type { EmbedTheme } from '@/lib/embed/embed-types'

interface EmbedState {
  post: BlogPost | null
  author: string
  loading: boolean
  error: string | null
}

function EmbedPageContent() {
  const searchParams = useSearchParams()
  const postId = searchParams.get('post')
  const ownerId = searchParams.get('owner')
  const themeParam = searchParams.get('theme')
  const theme: EmbedTheme = themeParam === 'dark' ? 'dark' : 'light'

  const [state, setState] = useState<EmbedState>({
    post: null,
    author: 'unknown',
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (!postId) {
        if (!cancelled) {
          setState({ post: null, author: 'unknown', loading: false, error: 'Missing post id.' })
        }
        return
      }

      setState((prev) => ({ ...prev, loading: true, error: null }))

      try {
        const post = await blogPostService.getPost(postId)
        if (!post) {
          if (!cancelled) {
            setState({ post: null, author: 'unknown', loading: false, error: 'Post not found.' })
          }
          return
        }

        if (ownerId && post.ownerId !== ownerId) {
          if (!cancelled) {
            setState({ post: null, author: 'unknown', loading: false, error: 'Owner does not match post.' })
          }
          return
        }

        const resolved = await dpnsService.resolveUsername(post.ownerId)
        const author = resolved || `${post.ownerId.slice(0, 8)}...`

        if (!cancelled) {
          setState({ post, author, loading: false, error: null })
        }
      } catch {
        if (!cancelled) {
          setState({ post: null, author: 'unknown', loading: false, error: 'Failed to load post.' })
        }
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setState({ post: null, author: 'unknown', loading: false, error: 'Failed to load post.' })
      }
    })

    return () => {
      cancelled = true
    }
  }, [ownerId, postId])

  const contentHtml = useMemo(() => {
    if (!state.post) return ''
    return renderEmbedHtml(state.post.content)
  }, [state.post])

  const viewPath = useMemo(() => {
    if (!state.post) return '/blog'
    return `/blog?blog=${encodeURIComponent(state.post.blogId)}&post=${encodeURIComponent(state.post.slug)}`
  }, [state.post])

  const createdLabel = state.post?.createdAt.toLocaleDateString() || ''

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: EMBED_STYLES }} />
      <div className="yappr-embed" data-yappr-theme={theme}>
        <article className="yappr-embed-article">
          {state.loading ? (
            <p className="yappr-embed-meta">Loading post...</p>
          ) : state.error ? (
            <p className="yappr-embed-meta">{state.error}</p>
          ) : state.post ? (
            <>
              <header className="yappr-embed-header">
                <h1 className="yappr-embed-title">{state.post.title}</h1>
                <p className="yappr-embed-meta">
                  {state.author} • {createdLabel}
                </p>
              </header>

              <div className="yappr-embed-content" dangerouslySetInnerHTML={{ __html: contentHtml }} />

              <footer className="yappr-embed-footer">
                <Link href={viewPath}>View on Yappr</Link>
              </footer>
            </>
          ) : (
            <p className="yappr-embed-meta">Post unavailable.</p>
          )}
        </article>
      </div>
    </>
  )
}

export default function EmbedPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-gray-500">Loading embed...</p>}>
      <EmbedPageContent />
    </Suspense>
  )
}
