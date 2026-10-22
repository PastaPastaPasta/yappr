'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { charterReasonText, peekCharterReasonText } from '@/lib/services/charter-reasons'
import { dpnsService } from '@/lib/services/dpns-service'

/**
 * The text of a hide's or restriction's label (`modLabel`, `restriction.reason`)
 * on `contract`, or null while unknown or unreadable: the label then reads
 * without a reason rather than a wrong one or a bare number.
 */
export function useModerationReasonText(contract: ModeratedContractKey, label: number | null | undefined): string | null {
  const known = typeof label === 'number' ? peekCharterReasonText(contract, label) : null
  const [text, setText] = useState<string | null>(known ?? null)
  useEffect(() => {
    if (typeof label !== 'number') {
      setText(null)
      return
    }
    let cancelled = false
    charterReasonText(contract, label).then((resolved) => {
      if (!cancelled) setText(resolved)
    }).catch(() => {
      if (!cancelled) setText(null)
    })
    return () => {
      cancelled = true
    }
  }, [contract, label])
  return text
}

/** "@alice" for the moderator who acted, or null while unresolved (the label leaves "by" out). */
export function useModeratorHandle(identityId: string | null | undefined): string | null {
  const [handle, setHandle] = useState<string | null>(null)
  useEffect(() => {
    if (!identityId) {
      setHandle(null)
      return
    }
    let cancelled = false
    dpnsService.resolveUsername(identityId).then((name) => {
      if (!cancelled) setHandle(name ? `@${name}` : `${identityId.slice(0, 8)}…`)
    }).catch((error: unknown) => {
      logger.warn('useModeratorHandle: username lookup failed', error)
      if (!cancelled) setHandle(`${identityId.slice(0, 8)}…`)
    })
    return () => {
      cancelled = true
    }
  }, [identityId])
  return handle
}
