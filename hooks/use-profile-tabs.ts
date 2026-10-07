'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { postService } from '@/lib/services/post-service'
import { mentionService } from '@/lib/services/mention-service'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import type { ProfileTab } from '@/components/profile/profile-tabs'
import { useProfileReplies } from '@/hooks/use-profile-replies'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { useHydratedPages } from '@/hooks/use-hydrated-pages'
import type { PostMentionDocument } from '@/lib/services/mention-service'

/** Mentioning posts fetched and enriched per page of the Mentions tab. */
const MENTIONS_PAGE_SIZE = 30

/** One page of mentions: the mentioning posts (and v10 replies), authentic only, newest first. */
async function hydrateMentions(mentionDocs: PostMentionDocument[]): Promise<Post[]> {
  const { posts, preloaded } = await mentionService.loadMentioningPosts(mentionDocs)
  return postService.enrichPostsBatch(posts, preloaded)
}

/**
 * The lazily loaded profile tabs: replies, top posts and mentions each fetch
 * the first time their tab is selected and reset when the profile changes.
 * The Posts tab is loaded with the profile itself, so it lives with it.
 */
export function useProfileTabs(userId: string | null, enrichProgressively: (posts: Post[]) => void) {
  const [activeTab, setActiveTab] = useState<ProfileTab>('posts')

  const mentions = useHydratedPages(hydrateMentions, MENTIONS_PAGE_SIZE)
  const { reset: resetMentions, clear: clearMentions } = mentions
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionsLoaded, setMentionsLoaded] = useState(false)
  const mentionsScroll = useInfiniteScroll({
    hasMore: mentions.hasMore,
    isLoading: mentions.loadingMore,
    onLoadMore: mentions.loadMore,
    disabled: activeTab !== 'mentions',
    resetKey: userId,
  })

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

  // The profile shown now: a mentions read for the previous one must not land here.
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  const loadMentions = useCallback(async () => {
    if (!userId || mentionsLoaded) return
    const isCurrent = () => userIdRef.current === userId
    setMentionsLoading(true)
    try {
      // Every mention (no cap), newest first; posts load a page at a time.
      const mentionDocs = await mentionService.getPostsMentioningUser(userId)
      if (isCurrent()) await resetMentions(mentionDocs)
    } catch (error) {
      logger.error('Failed to load mentions:', error)
      if (isCurrent()) await resetMentions([])
    } finally {
      if (isCurrent()) {
        setMentionsLoading(false)
        setMentionsLoaded(true)
      }
    }
  }, [userId, mentionsLoaded, resetMentions])

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
    clearMentions()
    setMentionsLoading(false)
    setMentionsLoaded(false)
    setTopPosts([])
    setTopLoaded(false)
    setActiveTab('posts')
  }, [userId, clearMentions])

  return {
    activeTab,
    setActiveTab,
    mentions: {
      posts: mentions.pages?.items ?? [],
      loading: mentionsLoading,
      hasMore: mentions.hasMore,
      loadingMore: mentions.loadingMore,
      isSuspended: mentionsScroll.isSuspended,
      sentinelRef: mentionsScroll.sentinelRef,
      onLoadMore: mentionsScroll.loadMore,
    },
    replies: {
      ...replies,
      isSuspended: repliesScroll.isSuspended,
      sentinelRef: repliesScroll.sentinelRef,
      onLoadMore: repliesScroll.loadMore,
    },
    top: { posts: topPosts, loading: topLoading, window: rankingWindow, onWindowChange: setRankingWindow },
  }
}
