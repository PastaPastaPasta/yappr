'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { mentionService } from '@/lib/services/mention-service'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import type { ProfileTab } from '@/components/profile/profile-tabs'
import { useProfileReplies } from '@/hooks/use-profile-replies'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'

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
  // A load failure surfaces through `replies.error` with its own retry, so the
  // sentinel only needs to hold off while that error is showing.
  const repliesScroll = useInfiniteScroll({
    hasMore: replies.hasMore && !replies.error,
    isLoading: replies.loading || replies.loadingMore,
    onLoadMore: replies.onLoadMore,
    disabled: activeTab !== 'replies',
    resetKey: userId,
  })

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
      // The mentioning posts (and v10 replies), authentic only, newest first.
      const { posts, preloaded } = await mentionService.loadMentioningPosts(mentionDocs)
      setMentions(await postService.enrichPostsBatch(posts, preloaded))
    } catch (error) {
      logger.error('Failed to load mentions:', error)
      setMentions([])
    } finally {
      setMentionsLoading(false)
      setMentionsLoaded(true)
    }
  }, [userId, mentionsLoaded])

  /**
   * One proved server-side ranked query on `like.byAuthorPost` (v10
   * `byAuthorPostTime`) pinned to this
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
    replies: {
      ...replies,
      isSuspended: repliesScroll.isSuspended,
      sentinelRef: repliesScroll.sentinelRef,
      onLoadMore: repliesScroll.loadMore,
    },
    top: { posts: topPosts, loading: topLoading, window: rankingWindow, onWindowChange: setRankingWindow },
  }
}
