'use client'

import { useState, useEffect, useCallback } from 'react'
import { LockClosedIcon, LockOpenIcon, CheckIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'

type PrivateFeedStatus = 'none' | 'pending' | 'approved' | 'approved-no-keys' | 'revoked' | 'loading' | 'no-private-feed'

interface PrivateFeedAccessButtonProps {
  /** The profile owner's identity ID */
  ownerId: string
  /** The current user's identity ID */
  currentUserId: string | null
  /** Whether the current user is following the profile owner */
  isFollowing: boolean
  /** Callback when auth is required */
  onRequireAuth: () => void
}

/**
 * Button component for requesting/managing private feed access on a profile page.
 * Implements PRD §4.7 - Request Access (Follower)
 */
export function PrivateFeedAccessButton({
  ownerId,
  currentUserId,
  isFollowing,
  onRequireAuth,
}: PrivateFeedAccessButtonProps) {
  const [status, setStatus] = useState<PrivateFeedStatus>('loading')
  const [isProcessing, setIsProcessing] = useState(false)
  const [showCancelOption, setShowCancelOption] = useState(false)

  // Load the current access status
  const loadStatus = useCallback(async () => {
    if (!currentUserId || !isFollowing) {
      setStatus('no-private-feed')
      return
    }

    try {
      const { privateFeedService, privateFeedFollowerService } = await import('@/lib/services')

      // First check if the owner has a private feed
      const hasPrivateFeed = await privateFeedService.hasPrivateFeed(ownerId)
      if (!hasPrivateFeed) {
        setStatus('no-private-feed')
        return
      }

      // Check our access status
      const accessStatus = await privateFeedFollowerService.getAccessStatus(ownerId, currentUserId)
      setStatus(accessStatus)
    } catch (error) {
      console.error('Error loading private feed status:', error)
      setStatus('no-private-feed')
    }
  }, [ownerId, currentUserId, isFollowing])

  useEffect(() => {
    loadStatus().catch(err => console.error('Failed to load status:', err))
  }, [loadStatus])

  // Handle requesting access
  const handleRequestAccess = async () => {
    if (!currentUserId) {
      onRequireAuth()
      return
    }

    setIsProcessing(true)
    try {
      const { privateFeedFollowerService, privateFeedCryptoService, identityService } = await import('@/lib/services')
      const { getEncryptionKey } = await import('@/lib/secure-storage')

      // Get the requester's encryption public key
      // First try to derive from stored private key, then fall back to identity
      let encryptionPublicKey: Uint8Array | undefined

      const storedKeyHex = getEncryptionKey(currentUserId)
      if (storedKeyHex) {
        // Derive public key from stored private key
        const privateKeyBytes = new Uint8Array(
          storedKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
        )
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
                const binary = atob(encryptionKey.data)
                encryptionPublicKey = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) {
                  encryptionPublicKey[i] = binary.charCodeAt(i)
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
        toast.error('You need an encryption key to request private feed access. Please enable your own private feed first.')
        setIsProcessing(false)
        return
      }

      const result = await privateFeedFollowerService.requestAccess(ownerId, currentUserId, encryptionPublicKey)

      if (result.success) {
        setStatus('pending')
        toast.success('Access requested')
      } else {
        toast.error(result.error || 'Failed to request access')
      }
    } catch (error) {
      console.error('Error requesting access:', error)
      toast.error('Failed to request access')
    } finally {
      setIsProcessing(false)
    }
  }

  // Handle canceling a pending request
  const handleCancelRequest = async () => {
    if (!currentUserId) return

    setIsProcessing(true)
    try {
      const { privateFeedFollowerService } = await import('@/lib/services')

      const result = await privateFeedFollowerService.cancelRequest(ownerId, currentUserId)

      if (result.success) {
        setStatus('none')
        setShowCancelOption(false)
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
  }

  // Don't show anything if user doesn't have a private feed or isn't following
  if (status === 'loading') {
    return (
      <div className="h-9 w-28 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
    )
  }

  if (status === 'no-private-feed' || !isFollowing) {
    return null
  }

  // Approved state (with or without local keys)
  if (status === 'approved' || status === 'approved-no-keys') {
    const needsRecovery = status === 'approved-no-keys'
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg ${
              needsRecovery
                ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30'
                : 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30'
            }`}>
              <LockOpenIcon className="h-4 w-4" />
              <span>Private</span>
              <CheckIcon className="h-3.5 w-3.5" />
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
              sideOffset={5}
            >
              {needsRecovery
                ? 'You have access but need to enter your encryption key to view private posts'
                : 'You have access to this user\'s private feed'}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    )
  }

  // Revoked state
  if (status === 'revoked') {
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <LockClosedIcon className="h-4 w-4" />
              <span>Revoked</span>
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
              sideOffset={5}
            >
              Your access to this private feed has been revoked
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    )
  }

  // Pending state - show with option to cancel on click
  if (status === 'pending') {
    if (showCancelOption) {
      return (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelRequest}
            disabled={isProcessing}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            {isProcessing ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Cancelling...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <XMarkIcon className="h-4 w-4" />
                Cancel
              </span>
            )}
          </Button>
          <button
            onClick={() => setShowCancelOption(false)}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )
    }

    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              onClick={() => setShowCancelOption(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
            >
              <ClockIcon className="h-4 w-4" />
              <span>Pending...</span>
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs"
              sideOffset={5}
            >
              Your request is pending approval. Click to cancel.
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    )
  }

  // None state - show request access button
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRequestAccess}
      disabled={isProcessing}
      className="border-yappr-500 text-yappr-600 hover:bg-yappr-50 dark:border-yappr-400 dark:text-yappr-400 dark:hover:bg-yappr-950/30"
    >
      {isProcessing ? (
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Requesting...
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <LockClosedIcon className="h-4 w-4" />
          Request Access
        </span>
      )}
    </Button>
  )
}
