'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationServiceFor } from '@/lib/services/moderation-service'

interface ModerationRole {
  /** On the contract's moderation team (its owner or an appointed or seated moderator). */
  isModerator: boolean
  /**
   * Protected from moderation (Drive `ContractModerators::protects`): whoever
   * may moderate now, plus a seated team's `ownerProtected` owner. Moderators
   * cannot delete such an identity's documents (41102), so its reports could
   * never be dismissed.
   */
  isProtected: boolean
  /**
   * Every identity protected from moderation right now (same rule as
   * `isProtected`): a moderator's removal of a document one of them owns is a
   * paid 41102, so no Remove is offered on it.
   */
  protectedIds: ReadonlySet<string>
}

const NONE: ModerationRole = { isModerator: false, isProtected: false, protectedIds: new Set() }

/**
 * The signed-in identity's standing on one contract's moderation (social by
 * default), read off the contract itself rather than a hardcoded id. Each
 * contract has its own team: a social moderator moderates nothing on the
 * storefront. Both false off a moderated cut, while logged out, and until the
 * contract has been fetched.
 */
export function useModerationRole(contract: ModeratedContractKey = 'social'): ModerationRole {
  const { user } = useAuth()
  const identityId = user?.identityId
  const [role, setRole] = useState<ModerationRole>(NONE)

  useEffect(() => {
    if (!identityId || !moderatedContract(contract).moderated()) {
      setRole(NONE)
      return
    }
    let cancelled = false
    const service = moderationServiceFor(contract)
    Promise.all([service.isModerator(identityId), service.getProtectedIdentities()]).then(([isModerator, protectedIds]) => {
      if (!cancelled) setRole({ isModerator, isProtected: isModerator || protectedIds.has(identityId), protectedIds })
    }).catch(() => {
      if (!cancelled) setRole(NONE)
    })
    return () => {
      cancelled = true
    }
  }, [identityId, contract])

  return role
}

/** Whether the signed-in identity is on the contract's moderation team (social by default). */
export function useIsModerator(contract: ModeratedContractKey = 'social'): boolean {
  return useModerationRole(contract).isModerator
}
