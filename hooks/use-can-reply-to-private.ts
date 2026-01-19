'use client'

import { useState, useEffect } from 'react'
import { Post } from '@/lib/types'
import { useAuth } from '@/contexts/auth-context'
import { isPrivatePost } from '@/components/post/private-post-content'

/**
 * Hook to check if the current user can reply to a private post.
 *
 * Per PRD §5.5, replies to private posts inherit encryption from the parent.
 * Users can only reply if:
 * 1. They are logged in
 * 2. They are the post owner, OR
 * 3. They have access to decrypt the post (approved follower with valid keys)
 *
 * Returns:
 * - canReply: boolean - Whether the user can reply
 * - isPrivate: boolean - Whether the post is private
 * - isLoading: boolean - Whether we're still checking access
 * - reason: string - Human-readable reason if can't reply
 */
export function useCanReplyToPrivate(post: Post): {
  canReply: boolean
  isPrivate: boolean
  isLoading: boolean
  reason: string | null
} {
  const { user } = useAuth()
  const [canDecrypt, setCanDecrypt] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const isPrivate = isPrivatePost(post)
  const isOwner = user?.identityId === post.author.id

  useEffect(() => {
    // If not private, always can reply (via public reply)
    if (!isPrivate) {
      setCanDecrypt(true)
      setIsLoading(false)
      return
    }

    // If not logged in, can't reply
    if (!user) {
      setCanDecrypt(false)
      setIsLoading(false)
      return
    }

    // If owner, can always reply
    if (isOwner) {
      setCanDecrypt(true)
      setIsLoading(false)
      return
    }

    // Check if user can decrypt
    const checkAccess = async () => {
      setIsLoading(true)
      try {
        const { privateFeedFollowerService } = await import('@/lib/services')
        const canDecryptPost = await privateFeedFollowerService.canDecrypt(post.author.id)
        setCanDecrypt(canDecryptPost)
      } catch (error) {
        console.error('Error checking private post access:', error)
        setCanDecrypt(false)
      } finally {
        setIsLoading(false)
      }
    }

    checkAccess()
  }, [isPrivate, user, isOwner, post.author.id])

  // Determine reason
  let reason: string | null = null
  if (isPrivate && !user) {
    reason = 'Log in to reply to private posts'
  } else if (isPrivate && canDecrypt === false) {
    reason = "Can't reply - no access to this private feed"
  }

  return {
    canReply: !isPrivate || (canDecrypt === true),
    isPrivate,
    isLoading,
    reason
  }
}
