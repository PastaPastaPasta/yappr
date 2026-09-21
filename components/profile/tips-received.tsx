'use client'

import { useEffect, useState } from 'react'
import { CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { provedTipService } from '@/lib/services/proved-tip-service'

interface TipsReceivedProps {
  identityId: string
}

/**
 * How many proved tips a profile has received, ever.
 *
 * A **count**, not a sum, and a lifetime one: two count-tree reads, each
 * O(log n) however many tips there are. Each counted document is a tip whose
 * amount, sender and payee consensus checked against the YAPP transfer it
 * cites, so this cannot be inflated by someone writing numbers under a post.
 *
 * The amounts are deliberately not totalled here. Summing them on chain would
 * need a `summable` index, and the agreement that makes `amount` trustworthy
 * forces it to a type `summable` refuses — see
 * docs/PLATFORM_SUMMABLE_AGREEMENT_GAP.md. Adding them up over a page instead
 * would be a figure "over the newest N", which is exactly the kind of number
 * this feature exists to stop showing.
 */
export function TipsReceived({ identityId }: TipsReceivedProps) {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    setCount(null)
    provedTipService
      .countTipsReceived(identityId)
      .then((received) => { if (active) setCount(received) })
      .catch((error) => logger.warn('TipsReceived: could not read the tip count', error))
    return () => { active = false }
  }, [identityId])

  if (!count) return null

  return (
    <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
      <CurrencyDollarIcon className="h-4 w-4 text-amber-500" aria-hidden="true" />
      <span>
        Tipped <span className="font-medium text-gray-900 dark:text-gray-100">{count}</span>{' '}
        {count === 1 ? 'time' : 'times'}
      </span>
    </div>
  )
}
