'use client'

import { useCallback } from 'react'
import { useAuth, AuthUser } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'

/**
 * Gate an action on being logged in.
 *
 * ```tsx
 * const { requireAuth } = useRequireAuth()
 * const handleLike = () => {
 *   const authedUser = requireAuth()
 *   if (!authedUser) return
 *   // authedUser.identityId is now type-safe
 * }
 * ```
 */
export function useRequireAuth() {
  const { user } = useAuth()
  const openLoginPrompt = useLoginModal((s) => s.open)

  /** The user when logged in; otherwise opens the login modal and returns null. */
  const requireAuth = useCallback((): AuthUser | null => {
    if (user) return user
    openLoginPrompt()
    return null
  }, [user, openLoginPrompt])

  return {
    isAuthenticated: !!user,
    user,
    requireAuth,
    /** Open the login modal directly. */
    openLoginPrompt,
  }
}
