'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { moderatedTypeWaitsForTeam, moderationElectionService } from '@/lib/services/moderation-election-service'

/**
 * Whether `docType` can be written now. On a contract registered with a
 * `notYetUsable` interim (mainnet v13) every post, reply, report and profile
 * extension is refused (41200) until masternodes seat the first moderation
 * team; there the seated team is read once per mount. Everywhere else it is
 * open without a read. A failed read counts as open: the write itself is
 * still refused with the same explanation if it is not.
 */
export function useModeratedTypeOpen(docType: string): boolean {
  const waits = moderatedTypeWaitsForTeam(docType)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!waits) return
    let cancelled = false
    moderationElectionService.moderatedTypeOpen(docType).then((value) => {
      if (!cancelled) setOpen(value)
    }).catch((error: unknown) => {
      logger.warn(`useModeratedTypeOpen(${docType}): could not read the seated team`, error)
    })
    return () => {
      cancelled = true
    }
  }, [docType, waits])

  return !waits || open
}
