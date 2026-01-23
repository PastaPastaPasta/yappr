'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import {
  getPrivateFeedRequestStatus,
  setPrivateFeedRequestStatus,
  deletePrivateFeedRequestStatus,
  subscribeToPrivateFeedRequestStatus,
  type PrivateFeedRequestStatus as CacheStatus,
} from '@/lib/caches/user-status-cache'

export type PrivateFeedRequestStatus = 'none' | 'pending' | 'loading' | 'error'

export interface UsePrivateFeedRequestOptions {
  /** The profile owner's identity ID */
  ownerId: string
  /** The current user's identity ID */
  currentUserId: string | null
  /** Callback when auth is required */
  onRequireAuth?: () => void
}

export interface UsePrivateFeedRequestReturn {
  /** Current status of the request */
  status: PrivateFeedRequestStatus
  /** Whether a request operation is in progress */
  isProcessing: boolean
  /** Whether the user needs to add an encryption key first */
  needsEncryptionKey: boolean
  /** Request access to the private feed */
  requestAccess: () => Promise<void>
  /** Cancel a pending request */
  cancelRequest: () => Promise<void>
  /** Callback when encryption key has been added via modal */
  onKeyAdded: () => Promise<void>
  /** Dismiss the encryption key requirement */
  dismissKeyModal: () => void
}

/**
 * Hook for requesting access to a user's private feed.
 * Extracts core logic from PrivateFeedAccessButton for reuse in feed posts.
 *
 * Features:
 * - Gets user's encryption public key (from storage or identity)
 * - Opens encryption key modal if no key available
 * - Auto-follows the user before requesting access
 * - Makes the access request via privateFeedFollowerService
 * - Uses shared cache so all posts from same author show consistent status
 */
export function usePrivateFeedRequest({
  ownerId,
  currentUserId,
  onRequireAuth,
}: UsePrivateFeedRequestOptions): UsePrivateFeedRequestReturn {
  // Build cache key for this owner
  const cacheKey = currentUserId ? `${currentUserId}:${ownerId}` : ''

  // Get initial status from cache
  const getInitialStatus = useCallback((): PrivateFeedRequestStatus => {
    if (!cacheKey) return 'none'
    const cached = getPrivateFeedRequestStatus(cacheKey)
    return cached || 'none'
  }, [cacheKey])

  const [status, setStatus] = useState<PrivateFeedRequestStatus>(getInitialStatus)
  const [isProcessing, setIsProcessing] = useState(false)
  const [needsEncryptionKey, setNeedsEncryptionKey] = useState(false)

  // Ref to track timeout IDs for cleanup on unmount
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Helper to schedule a delayed status update with cleanup
  const scheduleStatusReset = useCallback((newStatus: PrivateFeedRequestStatus, delayMs: number) => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      setStatus(newStatus)
      if (cacheKey) {
        deletePrivateFeedRequestStatus(cacheKey)
      }
    }, delayMs)
  }, [cacheKey])

  // Subscribe to cache changes so all posts from same author update together
  useEffect(() => {
    if (!cacheKey) return

    const unsubscribe = subscribeToPrivateFeedRequestStatus(() => {
      const cached = getPrivateFeedRequestStatus(cacheKey)
      // Reset to 'none' when cache entry is deleted/expired
      setStatus(cached ?? 'none')
    })

    return unsubscribe
  }, [cacheKey])

  // Update both local state and cache
  const updateStatus = useCallback((newStatus: PrivateFeedRequestStatus) => {
    setStatus(newStatus)
    if (cacheKey) {
      if (newStatus === 'pending' || newStatus === 'loading') {
        // Cache pending and loading states - these are the ones we want to share
        setPrivateFeedRequestStatus(cacheKey, newStatus as CacheStatus)
      } else {
        // Clear cache for 'none' and 'error' states to avoid stale entries
        deletePrivateFeedRequestStatus(cacheKey)
      }
    }
  }, [cacheKey])

  /**
   * Core logic to get encryption public key and make the request
   */
  const performRequest = useCallback(async () => {
    if (!currentUserId) {
      onRequireAuth?.()
      return
    }

    setIsProcessing(true)
    updateStatus('loading')

    try {
      const { privateFeedFollowerService, privateFeedCryptoService, identityService } = await import('@/lib/services')
      const { followService } = await import('@/lib/services/follow-service')
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')

      // Get the requester's encryption public key
      // First try to derive from stored private key, then fall back to identity
      let encryptionPublicKey: Uint8Array | undefined

      const privateKeyBytes = getEncryptionKeyBytes(currentUserId)
      if (privateKeyBytes) {
        // Derive public key from stored private key
        encryptionPublicKey = privateFeedCryptoService.getPublicKey(privateKeyBytes)
      } else {
        // Try to get from identity
        const identity = await identityService.getIdentity(currentUserId)
        if (identity?.publicKeys) {
          const encryptionKey = identity.publicKeys.find(
            (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
          )
          if (encryptionKey?.data) {
            // Convert to Uint8Array
            if (typeof encryptionKey.data === 'string') {
              // Base64 or hex
              if (/^[0-9a-fA-F]+$/.test(encryptionKey.data)) {
                const hexPairs = encryptionKey.data.match(/.{1,2}/g) || []
                encryptionPublicKey = new Uint8Array(
                  hexPairs.map(byte => parseInt(byte, 16))
                )
              } else {
                // Base64
                try {
                  const binary = atob(encryptionKey.data)
                  encryptionPublicKey = new Uint8Array(binary.length)
                  for (let i = 0; i < binary.length; i++) {
                    encryptionPublicKey[i] = binary.charCodeAt(i)
                  }
                } catch {
                  console.error('Failed to decode encryption key as base64')
                }
              }
            } else if (encryptionKey.data instanceof Uint8Array) {
              encryptionPublicKey = encryptionKey.data
            } else if (Array.isArray(encryptionKey.data)) {
              encryptionPublicKey = new Uint8Array(encryptionKey.data)
            }
          }
        }
      }

      if (!encryptionPublicKey) {
        // Need to open encryption key modal
        setNeedsEncryptionKey(true)
        setIsProcessing(false)
        updateStatus('none')
        return
      }

      // Auto-follow the owner if not already following (per plan)
      const isFollowing = await followService.isFollowing(ownerId, currentUserId)
      if (!isFollowing) {
        const followResult = await followService.followUser(currentUserId, ownerId)
        if (!followResult.success) {
          console.warn('Auto-follow failed:', followResult.error)
          // Continue anyway - the request might still work
        }
      }

      // Make the access request
      const result = await privateFeedFollowerService.requestAccess(ownerId, currentUserId, encryptionPublicKey)

      if (result.success) {
        updateStatus('pending')
        toast.success('Access requested')
      } else {
        updateStatus('error')
        toast.error(result.error || 'Failed to request access')
        // Reset to none after error so user can retry
        scheduleStatusReset('none', 2000)
      }
    } catch (error) {
      console.error('Error requesting access:', error)
      updateStatus('error')
      toast.error('Failed to request access')
      // Reset to none after error so user can retry
      scheduleStatusReset('none', 2000)
    } finally {
      setIsProcessing(false)
    }
  }, [currentUserId, ownerId, onRequireAuth, updateStatus, scheduleStatusReset])

  /**
   * Request access - main entry point
   */
  const requestAccess = useCallback(async () => {
    if (!currentUserId) {
      onRequireAuth?.()
      return
    }
    await performRequest()
  }, [currentUserId, onRequireAuth, performRequest])

  /**
   * Called after user adds encryption key via modal
   */
  const onKeyAdded = useCallback(async () => {
    setNeedsEncryptionKey(false)

    if (!currentUserId) {
      return
    }

    setIsProcessing(true)
    updateStatus('loading')

    try {
      const { privateFeedFollowerService, privateFeedCryptoService } = await import('@/lib/services')
      const { followService } = await import('@/lib/services/follow-service')
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')

      // Get the newly stored encryption key bytes
      const privateKeyBytes = getEncryptionKeyBytes(currentUserId)
      if (!privateKeyBytes) {
        toast.error('Encryption key not found. Please try again.')
        setIsProcessing(false)
        updateStatus('none')
        return
      }

      // Derive public key from stored private key
      const encryptionPublicKey = privateFeedCryptoService.getPublicKey(privateKeyBytes)

      // Auto-follow the owner if not already following
      const isFollowing = await followService.isFollowing(ownerId, currentUserId)
      if (!isFollowing) {
        const followResult = await followService.followUser(currentUserId, ownerId)
        if (!followResult.success) {
          console.warn('Auto-follow failed:', followResult.error)
        }
      }

      // Now make the access request
      const result = await privateFeedFollowerService.requestAccess(ownerId, currentUserId, encryptionPublicKey)

      if (result.success) {
        updateStatus('pending')
        toast.success('Access requested')
      } else {
        updateStatus('error')
        toast.error(result.error || 'Failed to request access')
        scheduleStatusReset('none', 2000)
      }
    } catch (error) {
      console.error('Error requesting access after key addition:', error)
      updateStatus('error')
      toast.error('Failed to request access')
      scheduleStatusReset('none', 2000)
    } finally {
      setIsProcessing(false)
    }
  }, [currentUserId, ownerId, updateStatus, scheduleStatusReset])

  /**
   * Cancel a pending request
   */
  const cancelRequest = useCallback(async () => {
    if (!currentUserId) return

    setIsProcessing(true)
    try {
      const { privateFeedFollowerService } = await import('@/lib/services')

      const result = await privateFeedFollowerService.cancelRequest(ownerId, currentUserId)

      if (result.success) {
        updateStatus('none')
        toast.success('Request cancelled')
      } else {
        toast.error(result.error || 'Failed to cancel request')
      }
    } catch (error) {
      console.error('Error canceling request:', error)
      toast.error('Failed to cancel request')
    } finally {
      setIsProcessing(false)
    }
  }, [currentUserId, ownerId, updateStatus])

  /**
   * Dismiss the encryption key modal without completing the request
   */
  const dismissKeyModal = useCallback(() => {
    setNeedsEncryptionKey(false)
    updateStatus('none')
  }, [updateStatus])

  return {
    status,
    isProcessing,
    needsEncryptionKey,
    requestAccess,
    cancelRequest,
    onKeyAdded,
    dismissKeyModal,
  }
}
