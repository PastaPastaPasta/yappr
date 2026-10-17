'use client'

import { useEffect, useState } from 'react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationServiceFor, type ModerationWarning } from '@/lib/services/moderation-service'

/** Where the warning applies and what it does not stop, per contract. */
const COPY: Record<ModeratedContractKey, { where: string; notBarred: string }> = {
  social: { where: 'Yappr', notBarred: 'A warning does not stop you posting.' },
  storefront: { where: 'Yappr stores', notBarred: 'A warning does not stop you selling or reviewing.' },
  blog: { where: 'Yappr blogs', notBarred: 'A warning does not stop you publishing or commenting.' },
}

/**
 * The signed-in identity's own warnings on one contract's warning list
 * (social by default; storefront and blogs keep lists of their own). A warning bars nothing, but it is public and precedes a
 * suspension or a ban, so the user should see it — with its reason — before
 * anyone else acts on it. Renders nothing when the contract keeps no warning
 * list or the user carries none.
 */
export function OwnWarningsNotice({ contract = 'social' }: { contract?: ModeratedContractKey }) {
  const { user } = useAuth()
  const identityId = user?.identityId
  const [warnings, setWarnings] = useState<ModerationWarning[]>([])

  useEffect(() => {
    if (!identityId || !moderatedContract(contract).listsKept().includes('warnings')) {
      setWarnings([])
      return
    }
    let cancelled = false
    moderationServiceFor(contract).getStanding(identityId).then((standing) => {
      if (!cancelled) setWarnings(standing.warnings)
    }).catch((error: unknown) => {
      logger.warn('OwnWarningsNotice: standing read failed', error)
    })
    return () => {
      cancelled = true
    }
  }, [identityId, contract])

  if (warnings.length === 0) return null
  return (
    <div data-testid={contract === 'social' ? 'own-warnings' : `own-warnings-${contract}`} role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
        <ExclamationTriangleIcon className="h-5 w-5" />
        You carry {warnings.length} moderator warning{warnings.length === 1 ? '' : 's'} on {COPY[contract].where}
      </p>
      <p className="mt-1 text-amber-800/80 dark:text-amber-300/80">
        {COPY[contract].notBarred} It is public, and repeated warnings usually come before a suspension.
      </p>
      <ul className="mt-2 list-disc ml-5 space-y-1">
        {warnings.map((warning) => (
          <li key={warning.warnedAt}>
            {new Date(warning.warnedAt).toLocaleDateString()}{warning.reason ? ` — ${warning.reason}` : ''}
            {warning.documents.length > 0 && (contract === 'social'
              ? ` (${warning.documents.length} post${warning.documents.length === 1 ? '' : 's'} cited)`
              : ` (${warning.documents.length} cited)`)}
          </li>
        ))}
      </ul>
    </div>
  )
}
