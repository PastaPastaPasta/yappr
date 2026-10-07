'use client'

import { useEffect, useState } from 'react'
import { electedModeration } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import { moderationService } from '@/lib/services/moderation-service'

/**
 * Whether `docType` can be written now. A contract registered with a
 * `notYetUsable` interim (mainnet v13) refuses every post, reply, report and
 * profile extension (41200) until masternodes seat the first moderation team,
 * so on an elected contract the registered declaration and the seated team
 * are read (cached, shared with the moderator checks). Off one it is open
 * without a read. Until the read answers, and when it fails, it counts as
 * open: the write itself is refused with the same explanation if it is not.
 */
export function useModeratedTypeOpen(docType: string): boolean {
  const moderated = electedModeration()?.moderatedDocumentTypes[docType] !== undefined
  const [closed, setClosed] = useState<string | null>(null)

  useEffect(() => {
    if (!moderated) return
    let cancelled = false
    moderationService.moderatedTypeOpen(docType).then((open) => {
      if (!cancelled) setClosed(open ? null : docType)
    }).catch((error: unknown) => {
      logger.warn(`useModeratedTypeOpen(${docType}): could not read the moderation team`, error)
    })
    return () => {
      cancelled = true
    }
  }, [docType, moderated])

  return closed !== docType
}
