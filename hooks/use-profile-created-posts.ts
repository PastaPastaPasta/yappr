'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Post } from '@/lib/types'
import { logger } from '@/lib/logger'
import { byNewestActivity } from '@/lib/feed/resolve-user-reposts'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { postService } from '@/lib/services/post-service'

/** Keep newly published posts independent of the profile's in-flight history load. */
export function useProfileCreatedPosts(
  userId: string | null,
  loadedPosts: Post[],
  enrichProgressively: (posts: Post[]) => void,
) {
  const [created, setCreated] = useState({ userId, posts: [] as Post[], count: null as number | null })

  useEffect(() => {
    let cancelled = false
    const pending = new Set<string>()
    setCreated({ userId, posts: [], count: null })

    const handleCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ post?: Post; postId?: string }>).detail
      const postId = detail?.postId ?? detail?.post?.id
      if (!userId || detail?.post?.author?.id !== userId || !postId || pending.has(postId)) return
      pending.add(postId)

      void (async () => {
        // Only add a canonical document. A successful broadcast can still be
        // unconfirmed, and must not turn into a confirmed-looking profile card.
        for (const delay of [0, 250, 500, 1000, 2000, 4000, 8000]) {
          if (delay) await new Promise(resolve => setTimeout(resolve, delay))
          if (cancelled) return
          const post = await postService.getPostById(postId)
          if (cancelled) return
          if (!post) continue
          if (post.author.id !== userId) return
          await attachQuotedPosts([post])
          if (cancelled) return
          setCreated(previous => ({
            ...previous,
            posts: [...previous.posts.filter(item => item.id !== post.id), post],
          }))
          const count = await postService.countUserPosts(userId)
          if (!cancelled) {
            // Concurrent publications can finish their count reads out of order.
            setCreated(previous => ({ ...previous, count: Math.max(previous.count ?? 0, count) }))
          }
          return
        }
        // A broadcast can stay unqueryable past the whole retry window (the DAPI
        // gateway routinely times out on confirmations that did succeed), so make
        // the resulting stale profile observable instead of failing silently.
        if (!cancelled) {
          logger.warn('Gave up reading back a newly published post; the profile may stay stale until reload', { postId })
        }
      })().catch(error => logger.error('Failed to refresh the newly published profile post:', error))
        .finally(() => pending.delete(postId))
    }

    window.addEventListener('post-created', handleCreated)
    return () => {
      cancelled = true
      window.removeEventListener('post-created', handleCreated)
    }
  }, [userId])

  const posts = useMemo(() => {
    if (created.userId !== userId || created.posts.length === 0) return loadedPosts
    const merged = new Map(loadedPosts.map(post => [post.id, post]))
    for (const post of created.posts) {
      if (!merged.has(post.id)) merged.set(post.id, post)
    }
    return [...merged.values()].sort(byNewestActivity)
  }, [userId, loadedPosts, created.posts, created.userId])

  // Enrich only the newly published posts. The merged list is a fresh array on
  // every history page and DPNS remap, and each enrichProgressively call cancels
  // the previous one, so enriching it here would abort the enrichment the profile
  // page starts for its own history and for each page it loads.
  useEffect(() => {
    if (created.userId === userId && created.posts.length > 0) enrichProgressively(created.posts)
  }, [userId, created.posts, created.userId, enrichProgressively])

  return { posts, count: created.userId === userId ? created.count : null }
}
