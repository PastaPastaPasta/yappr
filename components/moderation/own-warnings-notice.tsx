'use client'

import { useEffect, useState } from 'react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import { contractKeepsWarnings } from '@/lib/contract-topology'
import { moderationService, type ModerationWarning } from '@/lib/services/moderation-service'

/**
 * The signed-in identity's own warnings on the social contract's warning
 * list (v9). A warning bars nothing, but it is public and precedes a
 * suspension or a ban, so the user should see it — with its reason — before
 * anyone else acts on it. Renders nothing when the contract keeps no warning
 * list or the user carries none.
 */
export function OwnWarningsNotice() {
  const { user } = useAuth()
  const identityId = user?.identityId
  const [warnings, setWarnings] = useState<ModerationWarning[]>([])

  useEffect(() => {
    if (!identityId || !contractKeepsWarnings()) {
      setWarnings([])
      return
    }
    let cancelled = false
    moderationService.getStanding(identityId).then((standing) => {
      if (!cancelled) setWarnings(standing.warnings)
    }).catch((error: unknown) => {
      logger.warn('OwnWarningsNotice: standing read failed', error)
    })
    return () => {
      cancelled = true
    }
  }, [identityId])

  if (warnings.length === 0) return null
  return (
    <div data-testid="own-warnings" role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
        <ExclamationTriangleIcon className="h-5 w-5" />
        You carry {warnings.length} moderator warning{warnings.length === 1 ? '' : 's'} on Yappr
      </p>
      <p className="mt-1 text-amber-800/80 dark:text-amber-300/80">
        A warning does not stop you posting. It is public, and repeated warnings usually come before a suspension.
      </p>
      <ul className="mt-2 list-disc ml-5 space-y-1">
        {warnings.map((warning) => (
          <li key={warning.warnedAt}>
            {new Date(warning.warnedAt).toLocaleDateString()}{warning.reason ? ` — ${warning.reason}` : ''}
            {warning.documents.length > 0 && ` (${warning.documents.length} post${warning.documents.length === 1 ? '' : 's'} cited)`}
          </li>
        ))}
      </ul>
    </div>
  )
}
