'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { attachQuotedPosts } from '@/lib/feed/resolve-quoted-posts'
import { fetchReplyParents } from '@/lib/feed/resolve-reply-parents'
import { replyToPost } from '@/lib/services/post-service'
import { mentionService } from '@/lib/services/mention-service'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import type { ProfileTab } from '@/components/profile/profile-tabs'

/**
 * The lazily loaded profile tabs: replies, top posts and mentions each fetch
 * the first time their tab is selected and reset when the profile changes.
 * The Posts tab is loaded with the profile itself, so it lives with it.
 */
export function useProfileTabs(userId: string | null, enrichProgressively: (posts: Post[]) => void) {
  const [activeTab, setActiveTab] = useState<ProfileTab>('posts')

  const [mentions, setMentions] = useState<Post[]>([])
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionsLoaded, setMentionsLoaded] = useState(false)

  const [replies, setReplies] = useState<Post[]>([])
  const [repliesLoading, setRepliesLoading] = useState(false)
  const [repliesLoaded, setRepliesLoaded] = useState(false)
  const [replyParents, setReplyParents] = useState<Map<string, Post>>(new Map())
  const [replyParentsLoading, setReplyParentsLoading] = useState(false)

  const [topPosts, setTopPosts] = useState<Post[]>([])
  const [topLoading, setTopLoading] = useState(false)
  const [topLoaded, setTopLoaded] = useState(false)
  const [rankingWindow, setRankingWindow] = useState<RankingWindow>('all')

  const loadMentions = useCallback(async () => {
    if (!userId || mentionsLoaded) return
    setMentionsLoading(true)
    try {
      const mentionDocs = await mentionService.getPostsMentioningUser(userId)
      if (mentionDocs.length === 0) {
        setMentions([])
        return
      }
      const { postService } = await import('@/lib/services/post-service')
      const postIds = Array.from(new Set(mentionDocs.map((m) => m.postId)))
      const fetched: Post[] = []
      for (const postId of postIds) {
        try {
          const post = await postService.get(postId)
          // Only the post's own author may register a mention on it.
          const mentionDoc = mentionDocs.find((m) => m.postId === postId)
          if (post && mentionDoc && mentionDoc.$ownerId === post.author.id) fetched.push(post)
        } catch (error) {
          logger.error('Failed to fetch post:', postId, error)
        }
      }
      fetched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      setMentions(await postService.enrichPostsBatch(fetched))
    } catch (error) {
      logger.error('Failed to load mentions:', error)
      setMentions([])
    } finally {
      setMentionsLoading(false)
      setMentionsLoaded(true)
    }
  }, [userId, mentionsLoaded])

  const loadReplies = useCallback(async () => {
    if (!userId || repliesLoaded) return
    setRepliesLoading(true)
    try {
      const { replyService } = await import('@/lib/services/reply-service')
      const result = await replyService.getUserReplies(userId, { limit: 50 })
      if (result.documents.length === 0) {
        setReplies([])
        return
      }
      const replyPosts = result.documents.map(replyToPost)
      setReplies(replyPosts)
      enrichProgressively(replyPosts)
      // Resolve what each reply answers in the background; the cards render
      // immediately and fill their context in, the way enrichment does.
      setReplyParentsLoading(true)
      fetchReplyParents(replyPosts)
        .then(setReplyParents)
        .catch((err) => logger.error('Failed to load reply parents:', err))
        .finally(() => setReplyParentsLoading(false))
    } catch (error) {
      logger.error('Failed to load user replies:', error)
      setReplies([])
    } finally {
      setRepliesLoading(false)
      setRepliesLoaded(true)
    }
  }, [userId, repliesLoaded, enrichProgressively])

  /**
   * One proved server-side ranked query on `like.byAuthorPost` pinned to this
   * profile; the order and counts come from the count trees, not from a
   * client-side sort.
   */
  const loadTop = useCallback(async () => {
    if (!userId || topLoaded) return
    setTopLoading(true)
    try {
      const [{ topLikedPosts }, { postService }] = await Promise.all([import('@/lib/services/ranked-likes'), import('@/lib/services/post-service')])
      const ranked = await topLikedPosts({ postAuthor: userId, limit: 10, window: rankingWindow })
      if (ranked.length === 0) {
        setTopPosts([])
        return
      }
      const fetched = await postService.getPostsByIds(ranked.map((r) => r.postId))
      const byId = new Map(fetched.map((p) => [p.id, p]))
      // Keep the proved order; drop ids that failed to load.
      const ordered = ranked.map((r) => byId.get(r.postId)).filter((p): p is Post => p !== undefined)
      await attachQuotedPosts(ordered)
      setTopPosts(ordered)
      enrichProgressively(ordered)
    } catch (error) {
      logger.error('Failed to load top posts:', error)
      setTopPosts([])
    } finally {
      setTopLoading(false)
      setTopLoaded(true)
    }
  }, [userId, topLoaded, enrichProgressively, rankingWindow])

  // A window change reads a different index: drop the loaded Top list.
  useEffect(() => {
    setTopLoaded(false)
  }, [rankingWindow])

  useEffect(() => {
    if (activeTab === 'mentions' && !mentionsLoaded) loadMentions().catch((err) => logger.error('Failed to load mentions:', err))
  }, [activeTab, mentionsLoaded, loadMentions])
  useEffect(() => {
    if (activeTab === 'top' && !topLoaded) loadTop().catch((err) => logger.error('Failed to load top posts:', err))
  }, [activeTab, topLoaded, loadTop])
  useEffect(() => {
    if (activeTab === 'replies' && !repliesLoaded) loadReplies().catch((err) => logger.error('Failed to load user replies:', err))
  }, [activeTab, repliesLoaded, loadReplies])

  // A new profile starts on Posts with nothing loaded.
  useEffect(() => {
    setMentions([])
    setMentionsLoaded(false)
    setReplies([])
    setRepliesLoaded(false)
    setReplyParents(new Map())
    setReplyParentsLoading(false)
    setTopPosts([])
    setTopLoaded(false)
    setActiveTab('posts')
  }, [userId])

  return {
    activeTab,
    setActiveTab,
    mentions: { posts: mentions, loading: mentionsLoading },
    replies: { posts: replies, loading: repliesLoading, parents: replyParents, parentsLoading: replyParentsLoading },
    top: { posts: topPosts, loading: topLoading, window: rankingWindow, onWindowChange: setRankingWindow },
  }
}
