'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import { canBookmark, canRepost, type TargetKind } from '@/lib/contract-topology'
import { categorizeError, isFrozenBalanceError } from '@/lib/error-utils'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'

export interface EngagementSnapshot {
  liked: boolean
  likes: number
  reposted: boolean
  reposts: number
  bookmarked: boolean
}

/** Frozen accounts cannot spend at all, so say that instead of offering YAPP. */
function reportSpendError(error: unknown, buyReason: string, fallback: string) {
  if (isFrozenBalanceError(error)) toast.error(categorizeError(error))
  else if (!handleInsufficientYapp(error, buyReason)) toast.error(fallback)
}

/**
 * A card's like, repost and bookmark state with optimistic flips that roll
 * back on failure. Each write names the post, and on v3 that reference is
 * consensus-checked, so a post this session created but never saw confirmed
 * is settled first; the check is a no-op off the DAPI-timeout path.
 */
export function usePostEngagement(post: Post, viewerId: string | undefined, initial: EngagementSnapshot, targetKind: TargetKind) {
  // The v3 topology forbids reposting or bookmarking a reply at all.
  const repostable = canRepost(targetKind)
  const bookmarkable = canBookmark(targetKind)
  const [liked, setLiked] = useState(initial.liked)
  const [likes, setLikes] = useState(initial.likes)
  const [reposted, setReposted] = useState(initial.reposted)
  const [reposts, setReposts] = useState(initial.reposts)
  const [bookmarked, setBookmarked] = useState(initial.bookmarked)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)

  // Follow the enrichment snapshot as it fills in.
  useEffect(() => {
    setLiked(initial.liked)
    setLikes(initial.likes)
    setReposted(initial.reposted)
    setReposts(initial.reposts)
    setBookmarked(initial.bookmarked)
  }, [initial.liked, initial.likes, initial.reposted, initial.reposts, initial.bookmarked])

  const settle = useCallback(async () => {
    if (isUnconfirmed(post.id) && !(await settleUnconfirmed(post.id))) {
      throw new Error('This post has not confirmed yet. Try again in a moment.')
    }
  }, [post.id])

  const toggleLike = useCallback(async () => {
    if (!viewerId || likeLoading) return
    const wasLiked = liked
    const prevLikes = likes
    setLiked(!wasLiked)
    setLikes(wasLiked ? prevLikes - 1 : prevLikes + 1)
    setLikeLoading(true)
    try {
      await settle()
      const { likeService } = await import('@/lib/services/like-service')
      // On v4 the like repeats the target's author and hashtag under a
      // consensus-checked agreement; passing them saves the service a fetch.
      const targetInfo = { author: post.author.id, hashtag: post.hashtag }
      const ok = wasLiked
        ? await likeService.unlikePost(post.id, viewerId, targetKind, targetInfo)
        : await likeService.likePost(post.id, viewerId, post.author.id, targetKind, targetInfo)
      if (!ok) throw new Error('Like operation failed')
    } catch (error) {
      setLiked(wasLiked)
      setLikes(prevLikes)
      logger.error('Like error:', error)
      reportSpendError(error, 'You need YAPP to like posts. Buy some to continue.', 'Failed to update like. Please try again.')
    } finally {
      setLikeLoading(false)
    }
  }, [viewerId, likeLoading, liked, likes, settle, post.id, post.author.id, post.hashtag, targetKind])

  const toggleRepost = useCallback(async () => {
    // The topology may forbid reposting this kind (v3 replies); this guard, not
    // the action row, enforces it.
    if (!viewerId || !repostable || repostLoading) return
    const wasReposted = reposted
    const prevReposts = reposts
    setReposted(!wasReposted)
    setReposts(wasReposted ? prevReposts - 1 : prevReposts + 1)
    setRepostLoading(true)
    try {
      // Removal needs no gate: the repost document already exists.
      if (!wasReposted) await settle()
      const { repostService } = await import('@/lib/services/repost-service')
      const ok = wasReposted ? await repostService.removeRepost(post.id, viewerId) : await repostService.repostPost(post.id, viewerId, post.author.id)
      if (!ok) throw new Error('Repost operation failed')
      toast.success(wasReposted ? 'Removed repost' : 'Reposted!')
    } catch (error) {
      setReposted(wasReposted)
      setReposts(prevReposts)
      logger.error('Repost error:', error)
      reportSpendError(error, 'You need YAPP to repost. Buy some to continue.', 'Failed to update repost. Please try again.')
    } finally {
      setRepostLoading(false)
    }
  }, [viewerId, repostable, repostLoading, reposted, reposts, settle, post.id, post.author.id])

  const toggleBookmark = useCallback(async () => {
    if (!viewerId || !bookmarkable || bookmarkLoading) return
    const wasBookmarked = bookmarked
    setBookmarked(!wasBookmarked)
    setBookmarkLoading(true)
    try {
      if (!wasBookmarked) await settle()
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      const ok = wasBookmarked ? await bookmarkService.removeBookmark(post.id, viewerId) : await bookmarkService.bookmarkPost(post.id, viewerId)
      if (!ok) throw new Error('Bookmark operation failed')
      toast.success(wasBookmarked ? 'Removed from bookmarks' : 'Added to bookmarks')
    } catch (error) {
      setBookmarked(wasBookmarked)
      logger.error('Bookmark error:', error)
      toast.error('Failed to update bookmark. Please try again.')
    } finally {
      setBookmarkLoading(false)
    }
  }, [viewerId, bookmarkable, bookmarkLoading, bookmarked, settle, post.id])

  return {
    repostable,
    bookmarkable,
    liked,
    likes,
    reposted,
    reposts,
    bookmarked,
    likeLoading,
    repostLoading,
    bookmarkLoading,
    toggleLike,
    toggleRepost,
    toggleBookmark,
  }
}
