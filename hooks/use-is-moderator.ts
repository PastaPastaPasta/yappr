'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { contractIsModerated } from '@/lib/contract-topology'
import { moderationService } from '@/lib/services/moderation-service'

interface ModerationRole {
  /** On the social contract's moderation team (its owner or an appointed or seated moderator). */
  isModerator: boolean
  /**
   * Protected from moderation (Drive `ContractModerators::protects`): whoever
   * may moderate now, plus a seated team's `ownerProtected` owner. Moderators
   * cannot delete such an identity's documents (41102), so its reports could
   * never be dismissed.
   */
  isProtected: boolean
}

const NONE: ModerationRole = { isModerator: false, isProtected: false }

/**
 * The signed-in identity's standing on the social contract's moderation, read
 * off the contract itself rather than a hardcoded id. Both false off a
 * moderated topology, while logged out, and until the contract has been fetched.
 */
export function useModerationRole(): ModerationRole {
  const { user } = useAuth()
  const identityId = user?.identityId
  const [role, setRole] = useState<ModerationRole>(NONE)

  useEffect(() => {
    if (!identityId || !contractIsModerated()) {
      setRole(NONE)
      return
    }
    let cancelled = false
    Promise.all([moderationService.isModerator(identityId), moderationService.getProtectedIdentities()]).then(([isModerator, protectedIds]) => {
      if (!cancelled) setRole({ isModerator, isProtected: isModerator || protectedIds.has(identityId) })
    }).catch(() => {
      if (!cancelled) setRole(NONE)
    })
    return () => {
      cancelled = true
    }
  }, [identityId])

  return role
}

/** Whether the signed-in identity is on the social contract's moderation team. */
export function useIsModerator(): boolean {
  return useModerationRole().isModerator
}
