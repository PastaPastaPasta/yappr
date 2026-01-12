'use client'

import { useCallback } from 'react'
import { useAuth, AuthUser } from '@/contexts/auth-context'
import { useLoginPromptModal, LoginPromptAction } from '@/hooks/use-login-prompt-modal'

/**
 * Hook that provides utilities for requiring authentication before actions.
 *
 * Usage:
 * ```tsx
 * const { requireAuth } = useRequireAuth()
 *
 * const handleLike = () => {
 *   const authedUser = requireAuth('like')
 *   if (!authedUser) return
 *   // authedUser.identityId is now type-safe
 * }
 * ```
 */
export function useRequireAuth() {
  const { user } = useAuth()
  const { open: openLoginPrompt } = useLoginPromptModal()

  const isAuthenticated = !!user

  /**
   * Check if user is authenticated. If not, opens the login prompt modal.
   * @param action - The type of action being attempted (for display purposes)
   * @returns The authenticated user if logged in, null if login prompt was shown
   */
  const requireAuth = useCallback(
    (action: LoginPromptAction = 'generic'): AuthUser | null => {
      if (user) {
        return user
      }
      openLoginPrompt(action)
      return null
    },
    [user, openLoginPrompt]
  )

  return {
    /** Whether the user is currently authenticated */
    isAuthenticated,
    /** The current user object (null if not authenticated) */
    user,
    /** Check auth and show login prompt if needed. Returns the user if authenticated, null otherwise. */
    requireAuth,
    /** Directly open the login prompt modal */
    openLoginPrompt,
  }
}
