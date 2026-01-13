'use client'

import { useState, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useRequireAuth } from '@/hooks/use-require-auth'
import type { LoginPromptAction } from '@/hooks/use-login-prompt-modal'

interface InteractionState {
  active: boolean
  count: number
  loading: boolean
}

interface UseInteractionOptions {
  initialActive?: boolean
  initialCount?: number
  action: LoginPromptAction
  onToggle: (wasActive: boolean, userId: string) => Promise<boolean>
  successMessage?: { on: string; off: string }
  errorMessage?: string
}

/**
 * Generic hook for post interactions (like, repost, bookmark)
 * Handles optimistic updates, loading states, and error rollback
 */
function useInteraction({
  initialActive = false,
  initialCount = 0,
  action,
  onToggle,
  successMessage,
  errorMessage = 'Failed to update. Please try again.'
}: UseInteractionOptions) {
  const { requireAuth } = useRequireAuth()
  const [state, setState] = useState<InteractionState>({
    active: initialActive,
    count: initialCount,
    loading: false
  })

  // Sync with prop changes
  useEffect(() => {
    setState(prev => ({
      ...prev,
      active: initialActive,
      count: initialCount
    }))
  }, [initialActive, initialCount])

  const toggle = useCallback(async () => {
    const authedUser = requireAuth(action)
    if (!authedUser) return

    if (state.loading) return

    const wasActive = state.active
    const prevCount = state.count

    // Optimistic update
    setState({
      active: !wasActive,
      count: wasActive ? prevCount - 1 : prevCount + 1,
      loading: true
    })

    try {
      const success = await onToggle(wasActive, authedUser.identityId)
      if (!success) throw new Error(`${action} operation failed`)

      if (successMessage) {
        toast.success(wasActive ? successMessage.off : successMessage.on)
      }
    } catch (error) {
      // Rollback on error
      setState({
        active: wasActive,
        count: prevCount,
        loading: false
      })
      console.error(`${action} error:`, error)
      toast.error(errorMessage)
      return
    }

    setState(prev => ({ ...prev, loading: false }))
  }, [state, action, onToggle, successMessage, errorMessage, requireAuth])

  return {
    active: state.active,
    count: state.count,
    loading: state.loading,
    toggle
  }
}

export interface UsePostInteractionProps {
  postId: string
  initialLiked?: boolean
  initialLikes?: number
  initialReposted?: boolean
  initialReposts?: number
  initialBookmarked?: boolean
}

export interface PostInteractionState {
  liked: boolean
  likes: number
  likeLoading: boolean
  handleLike: () => Promise<void>
  reposted: boolean
  reposts: number
  repostLoading: boolean
  handleRepost: () => Promise<void>
  bookmarked: boolean
  bookmarkLoading: boolean
  handleBookmark: () => Promise<void>
}

/**
 * Hook that provides all post interaction state and handlers
 * Consolidates like, repost, and bookmark functionality into a single hook
 */
export function usePostInteraction({
  postId,
  initialLiked = false,
  initialLikes = 0,
  initialReposted = false,
  initialReposts = 0,
  initialBookmarked = false
}: UsePostInteractionProps): PostInteractionState {
  const like = useInteraction({
    initialActive: initialLiked,
    initialCount: initialLikes,
    action: 'like',
    onToggle: async (wasLiked, userId) => {
      const { likeService } = await import('@/lib/services/like-service')
      return wasLiked
        ? likeService.unlikePost(postId, userId)
        : likeService.likePost(postId, userId)
    }
  })

  const repost = useInteraction({
    initialActive: initialReposted,
    initialCount: initialReposts,
    action: 'repost',
    onToggle: async (wasReposted, userId) => {
      const { repostService } = await import('@/lib/services/repost-service')
      return wasReposted
        ? repostService.removeRepost(postId, userId)
        : repostService.repostPost(postId, userId)
    },
    successMessage: { on: 'Reposted!', off: 'Removed repost' }
  })

  const bookmark = useInteraction({
    initialActive: initialBookmarked,
    initialCount: 0, // Bookmarks don't have a count
    action: 'bookmark',
    onToggle: async (wasBookmarked, userId) => {
      const { bookmarkService } = await import('@/lib/services/bookmark-service')
      return wasBookmarked
        ? bookmarkService.removeBookmark(postId, userId)
        : bookmarkService.bookmarkPost(postId, userId)
    },
    successMessage: { on: 'Added to bookmarks', off: 'Removed from bookmarks' }
  })

  return {
    liked: like.active,
    likes: like.count,
    likeLoading: like.loading,
    handleLike: like.toggle,
    reposted: repost.active,
    reposts: repost.count,
    repostLoading: repost.loading,
    handleRepost: repost.toggle,
    bookmarked: bookmark.active,
    bookmarkLoading: bookmark.loading,
    handleBookmark: bookmark.toggle
  }
}
