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
 * 2. They are the post owner (or root post owner), OR
 * 3. They have access to decrypt the post (approved follower with valid keys)
 *
 * @param post - The post to check reply permissions for
 * @param rootPostOwnerId - Optional: The root/parent post owner ID. For replies to private posts,
 *                          access should be checked against the root post owner, not the reply author.
 *                          If not provided and the post is a reply, will walk the chain to find it.
 *
 * Returns:
 * - canReply: boolean - Whether the user can reply
 * - isPrivate: boolean - Whether the post is private
 * - isLoading: boolean - Whether we're still checking access
 * - reason: string - Human-readable reason if can't reply
 */
export function useCanReplyToPrivate(post: Post | null | undefined, rootPostOwnerId?: string): {
  canReply: boolean
  isPrivate: boolean
  isLoading: boolean
  reason: string | null
} {
  const { user } = useAuth()
  const [canDecrypt, setCanDecrypt] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Handle null/undefined post (e.g., while loading)
  const isPrivate = post ? isPrivatePost(post) : false

  useEffect(() => {
    // If post not loaded yet, stay in loading state
    if (!post) {
      setIsLoading(true)
      return
    }

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

    // Check if user can decrypt
    const checkAccess = async () => {
      setIsLoading(true)
      try {
        // Resolve the actual feed owner for inherited encryption
        // If rootPostOwnerId is provided, use it; otherwise walk the chain
        let feedOwnerId = rootPostOwnerId || post.author.id

        // For private posts that are replies, find the actual encryption source owner
        if (!rootPostOwnerId && post.replyToId) {
          const { getEncryptionSource } = await import('@/lib/services/post-service')
          const encryptionSource = await getEncryptionSource(post.replyToId)
          if (encryptionSource) {
            feedOwnerId = encryptionSource.ownerId
          }
        }

        // If current user is the feed owner, can always reply
        if (user.identityId === feedOwnerId) {
          setCanDecrypt(true)
          return
        }

        // Check if user has access to decrypt
        const { privateFeedFollowerService } = await import('@/lib/services')
        const canDecryptPost = await privateFeedFollowerService.canDecrypt(feedOwnerId)
        setCanDecrypt(canDecryptPost)
      } catch (error) {
        console.error('Error checking private post access:', error)
        setCanDecrypt(false)
      } finally {
        setIsLoading(false)
      }
    }

    checkAccess().catch(error => {
      console.error('Error in checkAccess:', error)
      setCanDecrypt(false)
      setIsLoading(false)
    })
  }, [post, isPrivate, user, rootPostOwnerId])

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
