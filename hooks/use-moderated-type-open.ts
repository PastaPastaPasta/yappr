'use client'

import { useEffect, useState } from 'react'
import { electedModeration } from '@/lib/contract-topology'
import { watchModeratedTypeOpen } from '@/lib/moderated-type-gate'
import { moderationService } from '@/lib/services/moderation-service'

/**
 * Whether `docType` can be written now. A contract registered with a
 * `notYetUsable` interim (mainnet v13) refuses every post, reply, report and
 * profile extension (41200) until masternodes seat the first moderation team,
 * so on an elected contract the registered declaration and the seated team
 * are read (cached, shared with the moderator checks). Off one it is open
 * without a read. Until the read answers, and when it fails, it counts as
 * open: the write itself is refused with the same explanation if it is not.
 *
 * While `active` (the dialog that writes it is open), the gate reads again on
 * every activation, every minute while it is closed, and whenever the window
 * regains focus, so a session opened before the first team was seated opens
 * once one is, without a reload.
 */
export function useModeratedTypeOpen(docType: string, active = true): boolean {
  const moderated = electedModeration()?.moderatedDocumentTypes[docType] !== undefined
  const [closed, setClosed] = useState<string | null>(null)

  useEffect(() => {
    if (!moderated || !active) return
    return watchModeratedTypeOpen(
      () => moderationService.moderatedTypeOpen(docType),
      (open) => setClosed(open ? null : docType),
      { targets: typeof window === 'undefined' ? [] : [window, document] }
    )
  }, [docType, moderated, active])

  return closed !== docType
}
