'use client'

import { useEffect, useState } from 'react'
import { CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { tipHistoryService, totalTipped, TIP_PAGE_LIMIT } from '@/lib/services/tip-history-service'

interface YappFlowProps {
  identityId: string
  /** Viewing your own profile also shows what you have sent — your own history, not anyone else's. */
  isOwnProfile?: boolean
}

interface FlowSummary {
  receivedTotal: bigint
  receivedCount: number
  sentTotal: bigint
  sentCount: number
}

/**
 * Proved YAPP flow for a profile, read back from the token-history contract.
 *
 * Deliberately labelled **YAPP received / sent**, not "tips received". The
 * `to` index carries every incoming YAPP transfer — a storefront settlement, a
 * repayment, a faucet drip — and only the ones whose `publicNote` names a post
 * are identifiable as tips. Calling the sum "tips" would be exactly the kind of
 * unearned claim this whole feature exists to delete. Per-post tips, which ARE
 * attributable, are shown by `components/post/post-tips.tsx`.
 *
 * The history contract is a system contract with no count or sum trees, so
 * there is no proved lifetime total either: these are sums over the newest page
 * of transfers on each index, and the label says so.
 */
export function YappFlow({ identityId, isOwnProfile = false }: YappFlowProps) {
  const [summary, setSummary] = useState<FlowSummary | null>(null)

  useEffect(() => {
    let active = true
    setSummary(null)
    Promise.all([
      tipHistoryService.getTipsReceived(identityId),
      isOwnProfile ? tipHistoryService.getTipsSent(identityId) : Promise.resolve([]),
    ])
      .then(([received, sent]) => {
        if (!active) return
        setSummary({
          receivedTotal: totalTipped(received),
          receivedCount: received.length,
          sentTotal: totalTipped(sent),
          sentCount: sent.length,
        })
      })
      .catch((error) => {
        logger.warn('YappFlow: could not load transfers', error)
        if (active) setSummary(null)
      })
    return () => { active = false }
  }, [identityId, isOwnProfile])

  if (!summary || (summary.receivedCount === 0 && summary.sentCount === 0)) return null

  return (
    <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
      <span className="flex items-center gap-2">
        <CurrencyDollarIcon className="h-4 w-4 text-amber-500" aria-hidden="true" />
        YAPP received:{' '}
        <span className="font-medium text-gray-900 dark:text-gray-100">{summary.receivedTotal.toString()}</span>
      </span>
      {isOwnProfile && summary.sentCount > 0 && (
        <span>
          YAPP sent:{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">{summary.sentTotal.toString()}</span>
        </span>
      )}
      <span className="text-xs text-gray-500">
        (transfers in and out, tips included — last {TIP_PAGE_LIMIT} on chain)
      </span>
    </div>
  )
}
