'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { restrictionServiceFor } from '@/lib/services/restriction-service'

/**
 * Whether `authorId` has a restriction in force on `contract` (social v18,
 * blog v10), for a moderator's menu to offer "Restrict" or "Lift". Read only
 * while `enabled` (a moderator looking at someone else's item); null while
 * unknown or off a cut that restricts. Storefront keeps no restrictions.
 */
export function useAuthorRestricted(contract: ModeratedContractKey, authorId: string | null | undefined, enabled: boolean): boolean | null {
  const [restricted, setRestricted] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled || !authorId || contract === 'storefront') {
      setRestricted(null)
      return
    }
    const service = restrictionServiceFor(contract)
    if (!service.supported()) {
      setRestricted(null)
      return
    }
    let cancelled = false
    service.isRestricted(authorId).then((value) => {
      if (!cancelled) setRestricted(value)
    }).catch((error: unknown) => {
      logger.warn('useAuthorRestricted: could not read the author\'s standing', error)
      if (!cancelled) setRestricted(null)
    })
    return () => {
      cancelled = true
    }
  }, [contract, authorId, enabled])
  return restricted
}
