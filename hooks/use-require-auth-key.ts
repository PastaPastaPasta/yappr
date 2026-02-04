'use client'

import { useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useAuthKeyModal } from './use-auth-key-modal'

/**
 * Hook to require auth key for operations.
 *
 * If the user's private key has been deleted from storage mid-session,
 * this will open the auth key modal. Otherwise, it will execute the callback.
 *
 * Example usage:
 * ```tsx
 * const { requireAuthKey, hasAuthKey } = useRequireAuthKey()
 *
 * const handleSendMessage = async () => {
 *   const canProceed = requireAuthKey(() => {
 *     // This callback will be called after the key is entered successfully
 *     doSendMessage()
 *   })
 *   if (!canProceed) return // Modal was opened, user needs to enter key
 * }
 * ```
 */
export function useRequireAuthKey() {
  const { user } = useAuth()
  const { open: openModal } = useAuthKeyModal()

  /**
   * Check if the user has a private key stored
   */
  const hasAuthKey = useCallback((): boolean => {
    if (typeof window === 'undefined' || !user) return false

    // Dynamically check secure storage to avoid SSR issues
    try {
      const { hasPrivateKey } = require('@/lib/secure-storage')
      return hasPrivateKey(user.identityId)
    } catch {
      return false
    }
  }, [user])

  /**
   * Require auth key for an action.
   * Returns true if key is available, false if modal was opened.
   */
  const requireAuthKey = useCallback((
    onSuccess?: () => void,
    onCancel?: () => void
  ): boolean => {
    if (!user) return false

    if (hasAuthKey()) {
      // Key is available, proceed
      if (onSuccess) onSuccess()
      return true
    }

    // Key not available, open modal
    openModal(onSuccess, onCancel)
    return false
  }, [user, hasAuthKey, openModal])

  /**
   * Async version that resolves when key is entered or rejects if cancelled
   */
  const requireAuthKeyAsync = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!user) {
        reject(new Error('User not logged in'))
        return
      }

      if (hasAuthKey()) {
        resolve()
        return
      }

      // Open modal and wait for completion
      openModal(
        () => resolve(),
        () => reject(new Error('Auth key entry cancelled'))
      )
    })
  }, [user, hasAuthKey, openModal])

  return {
    hasAuthKey,
    requireAuthKey,
    requireAuthKeyAsync,
  }
}
