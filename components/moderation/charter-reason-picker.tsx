'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { electedModeration } from '@/lib/contract-topology'
import { moderationElectionService, type CharterReason } from '@/lib/services/moderation-election-service'

/**
 * The reasons the seated elected team may cite. Once a team is seated on an
 * elected contract (v9), every ban, suspension, warning and deletion it signs
 * must name one of its proposal's `reason` documents (41203 otherwise); lifting
 * and restoring are not bound, and neither is the interim. `required` is true
 * exactly when a reason must be picked.
 */
export function useSeatedReasons(): { reasons: CharterReason[]; required: boolean; loading: boolean } {
  const elected = electedModeration() !== null
  const [state, setState] = useState<{ reasons: CharterReason[]; required: boolean; loading: boolean }>({ reasons: [], required: false, loading: elected })

  useEffect(() => {
    if (!elected) return
    let cancelled = false
    ;(async () => {
      const seated = await moderationElectionService.getSeatedTeam()
      const reasons = seated ? await moderationElectionService.getSeatedReasons() : []
      if (!cancelled) setState({ reasons, required: seated !== null, loading: false })
    })().catch((error: unknown) => {
      logger.warn('useSeatedReasons: could not read the seated team', error)
      if (!cancelled) setState({ reasons: [], required: false, loading: false })
    })
    return () => {
      cancelled = true
    }
  }, [elected])

  return state
}

interface CharterReasonPickerProps {
  id: string
  reasons: CharterReason[]
  value: string
  onChange: (reasonDocumentId: string) => void
}

/** A select of the seated team's reasons; the value is the `reason` document id to cite. */
export function CharterReasonPicker({ id, reasons, value, onChange }: CharterReasonPickerProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Charter reason (required for the elected team)
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
      >
        <option value="">Choose the ground for this action…</option>
        {reasons.map((reason) => (
          <option key={reason.id} value={reason.id}>{reason.code} — {reason.label}</option>
        ))}
      </select>
      {reasons.length === 0 && (
        <p className="mt-1 text-xs text-red-500">The seated team&apos;s proposal lists no reasons, so it can take no such action.</p>
      )}
    </div>
  )
}
