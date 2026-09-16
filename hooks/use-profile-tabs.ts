'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { mentionService } from '@/lib/services/mention-service'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import type { ProfileTab } from '@/components/profile/profile-tabs'
import { useProfileReplies } from '@/hooks/use-profile-replies'

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

  const replies = useProfileReplies(userId, enrichProgressively)

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
    const load = activeTab === 'mentions' ? loadMentions : activeTab === 'top' ? loadTop : activeTab === 'replies' && !replies.loaded ? replies.load : null
    load?.().catch((err) => logger.error(`Failed to load ${activeTab}:`, err))
  }, [activeTab, loadMentions, loadTop, replies.loaded, replies.load])

  // A new profile starts on Posts with nothing loaded.
  useEffect(() => {
    setMentions([])
    setMentionsLoaded(false)
    setTopPosts([])
    setTopLoaded(false)
    setActiveTab('posts')
  }, [userId])

  return {
    activeTab,
    setActiveTab,
    mentions: { posts: mentions, loading: mentionsLoading },
    replies,
    top: { posts: topPosts, loading: topLoading, window: rankingWindow, onWindowChange: setRankingWindow },
  }
}
