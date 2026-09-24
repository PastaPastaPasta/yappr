'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { electedModeration } from '@/lib/contract-topology'
import { moderationElectionService, type CharterReason } from '@/lib/services/moderation-election-service'

export interface SeatedReasonsState {
  reasons: CharterReason[]
  /** True when a team is seated, so every bound action must cite one of `reasons` (41203 otherwise). */
  required: boolean
  loading: boolean
  /** The seat or its reasons could not be read: a reason picker cannot be offered honestly. */
  failed: boolean
}

const IDLE: SeatedReasonsState = { reasons: [], required: false, loading: false, failed: false }

/**
 * The reasons the seated elected team may cite. Once a team is seated on an
 * elected contract (v9), every ban, suspension, warning and deletion it signs
 * must name one of its proposal's `reason` documents (41203 otherwise); lifting
 * and restoring are not bound, and neither is the interim.
 *
 * Reads nothing until `active` (the modal is open, the moderator panel is
 * shown) and reads again every time it becomes active, so a team seated
 * mid-session is picked up on the next open. One team read feeds both the
 * "is a team seated" answer and the reasons.
 */
export function useSeatedReasons(active: boolean): SeatedReasonsState {
  const elected = electedModeration() !== null
  const [state, setState] = useState<SeatedReasonsState>(IDLE)

  useEffect(() => {
    if (!active || !elected) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState({ ...IDLE, loading: true })
    moderationElectionService.getSeatedTeamAndReasons().then(({ seated, reasons }) => {
      if (!cancelled) setState({ reasons, required: seated !== null, loading: false, failed: false })
    }).catch((error: unknown) => {
      logger.warn('useSeatedReasons: could not read the seated team or its reasons', error)
      if (!cancelled) setState({ reasons: [], required: false, loading: false, failed: true })
    })
    return () => {
      cancelled = true
    }
  }, [active, elected])

  return state
}

interface CharterReasonPickerProps {
  id: string
  state: SeatedReasonsState
  value: string
  onChange: (reasonDocumentId: string) => void
}

/**
 * A select of the seated team's reasons; the value is the `reason` document id
 * to cite. Renders nothing when no team is seated; says so when the seat could
 * not be read, rather than pretending the charter lists no reasons.
 */
export function CharterReasonPicker({ id, state, value, onChange }: CharterReasonPickerProps) {
  if (state.failed) {
    return (
      <p role="alert" className="text-xs text-red-500">
        Could not read the elected team&apos;s charter. If a team is seated, its actions must cite a charter reason; try again.
      </p>
    )
  }
  if (!state.required) return null
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
        {state.reasons.map((reason) => (
          <option key={reason.id} value={reason.id}>{reason.code} — {reason.label}</option>
        ))}
      </select>
      {state.reasons.length === 0 && (
        <p className="mt-1 text-xs text-red-500">The seated team&apos;s proposal lists no reasons, so it can take no such action.</p>
      )}
    </div>
  )
}
