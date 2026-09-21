'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { contractIsModerated } from '@/lib/contract-topology'
import { moderationService } from '@/lib/services/moderation-service'

/**
 * Whether the signed-in identity is on the social contract's moderation team
 * (its owner or an appointed moderator), read off the contract itself rather
 * than a hardcoded id. False off a moderated topology, while logged out, and
 * until the contract has been fetched.
 */
export function useIsModerator(): boolean {
  const { user } = useAuth()
  const identityId = user?.identityId
  const [isModerator, setIsModerator] = useState(false)

  useEffect(() => {
    if (!identityId || !contractIsModerated()) {
      setIsModerator(false)
      return
    }
    let cancelled = false
    moderationService.isModerator(identityId).then((result) => {
      if (!cancelled) setIsModerator(result)
    }).catch(() => {
      if (!cancelled) setIsModerator(false)
    })
    return () => {
      cancelled = true
    }
  }, [identityId])

  return isModerator
}
