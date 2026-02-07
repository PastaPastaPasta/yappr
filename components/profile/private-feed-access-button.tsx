'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { LockClosedIcon, LockOpenIcon, CheckIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { usePrivateFeedRequest } from '@/hooks/use-private-feed-request'

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
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Use the shared hook for request logic
  const {
    isProcessing: isRequestProcessing,
    needsEncryptionKey,
    requestAccess,
    onKeyAdded,
    dismissKeyModal,
  } = usePrivateFeedRequest({
    ownerId,
    currentUserId,
    onRequireAuth,
  })

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

    // Cleanup: clear any pending timeouts on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [loadStatus])

  // Handle requesting access - delegates to hook
  const handleRequestAccess = async () => {
    await requestAccess()
    // If request succeeded, the hook shows a toast and we reload status
    // Use a small delay to allow the transaction to propagate
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      loadStatus().catch(console.error)
    }, 1000)
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
        // If no pending request exists, update status to reflect reality
        // This handles race conditions where the request was already processed
        if (result.error?.toLowerCase().includes('no pending request')) {
          setStatus('none')
          setShowCancelOption(false)
        }
        toast.error(result.error || 'Failed to cancel request')
      }
    } catch (error) {
      console.error('Error canceling request:', error)
      toast.error('Failed to cancel request')
    } finally {
      setIsProcessing(false)
    }
  }

  // Handle success from AddEncryptionKeyModal - delegates to hook
  const handleAddKeySuccess = useCallback(async () => {
    await onKeyAdded()
    // Reload status after key addition and request
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      loadStatus().catch(console.error)
    }, 1000)
  }, [onKeyAdded, loadStatus])

  // Render helper for the button content based on status
  const renderButton = () => {
    // Loading state
    if (status === 'loading') {
      return <div className="h-9 w-28 bg-surface-100 dark:bg-surface-800 rounded-lg animate-pulse" />
    }

    // Don't show button if user doesn't have a private feed or isn't following
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
              <div data-testid="access-approved" className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg ${
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
                className="bg-gray-800 dark:bg-surface-700 text-white text-xs px-2 py-1 rounded max-w-xs"
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
              <div data-testid="access-revoked" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-surface-500 dark:text-surface-400 bg-surface-100 dark:bg-surface-800 rounded-lg">
                <LockClosedIcon className="h-4 w-4" />
                <span>Revoked</span>
              </div>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                className="bg-gray-800 dark:bg-surface-700 text-white text-xs px-2 py-1 rounded max-w-xs"
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
              data-testid="cancel-request-btn"
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
              type="button"
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
                type="button"
                data-testid="access-pending"
                onClick={() => setShowCancelOption(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
              >
                <ClockIcon className="h-4 w-4" />
                <span>Pending...</span>
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                className="bg-gray-800 dark:bg-surface-700 text-white text-xs px-2 py-1 rounded max-w-xs"
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
    const buttonIsProcessing = isProcessing || isRequestProcessing
    return (
      <Button
        data-testid="request-access-btn"
        variant="outline"
        size="sm"
        onClick={handleRequestAccess}
        disabled={buttonIsProcessing}
        className="border-yappr-500 text-yappr-600 hover:bg-yappr-50 dark:border-yappr-400 dark:text-yappr-400 dark:hover:bg-yappr-950/30"
      >
        {buttonIsProcessing ? (
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

  const buttonContent = renderButton()

  // If no button to render and no modal, return null
  if (!buttonContent && !needsEncryptionKey) {
    return null
  }

  return (
    <>
      {buttonContent}
      <AddEncryptionKeyModal
        isOpen={needsEncryptionKey}
        onClose={dismissKeyModal}
        onSuccess={handleAddKeySuccess}
      />
    </>
  )
}
