'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { fetchReplyParents } from '@/lib/feed/resolve-reply-parents'
import { postService, replyToPost } from '@/lib/services/post-service'
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
      const postIds = Array.from(new Set(mentionDocs.map((m) => m.postId)))
      const { posts, preloaded } = await postService.getPostsByIdsForDisplay(postIds)
      // Only the post's own author may register a mention on it.
      const fetched = posts.filter(post => mentionDocs.some(
        mention => mention.postId === post.id && mention.$ownerId === post.author.id
      ))
      fetched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      setMentions(await postService.enrichPostsBatch(fetched, preloaded))
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
      const { topLikedPostsHydrated } = await import('@/lib/services/ranked-likes')
      setTopPosts(await topLikedPostsHydrated({ postAuthor: userId, limit: 10, window: rankingWindow }))
    } catch (error) {
      logger.error('Failed to load top posts:', error)
      setTopPosts([])
    } finally {
      setTopLoading(false)
      setTopLoaded(true)
    }
  }, [userId, topLoaded, rankingWindow])

  // A window change reads a different index: drop the loaded Top list.
  useEffect(() => {
    setTopLoaded(false)
  }, [rankingWindow])

  // Each loader is a no-op once its list is loaded, so this may fire freely.
  useEffect(() => {
    const load = activeTab === 'mentions' ? loadMentions : activeTab === 'top' ? loadTop : activeTab === 'replies' ? loadReplies : null
    load?.().catch((err) => logger.error(`Failed to load ${activeTab}:`, err))
  }, [activeTab, loadMentions, loadTop, loadReplies])

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
