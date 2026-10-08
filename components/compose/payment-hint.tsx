'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { tokenCostFor, yappIsPausedForGood } from '@/lib/contract-topology'
import { paymentHintCopy, paymentIsChoosable, planPayment } from '@/lib/payment-preference'
import { tokenService } from '@/lib/services/token-service'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'

/**
 * What the compose is about to spend, on a contract where the user can
 * choose (v9): "10 YAPP, network fee covered" or "credits". Where YAPP is
 * paused for good (v10–v13) it always says credits, with no switch and no
 * balance read. Nothing on contracts where the token cost is required — there is no
 * choice to show.
 */
export function PaymentHint({ docType }: { docType: 'post' | 'reply' }) {
  const { user } = useAuth()
  const payWith = useSettingsStore((s) => s.payWith)
  const setPayWith = useSettingsStore((s) => s.setPayWith)
  // `undefined` = not fetched yet (render nothing), `null` = fetch failed.
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined)
  const identityId = user?.identityId
  const paused = yappIsPausedForGood()
  // An optional cost is shown even when paused: the hint still names the fee.
  const shown = tokenCostFor(docType)?.optional === true

  useEffect(() => {
    if (!identityId || !paymentIsChoosable(docType)) return
    let cancelled = false
    tokenService.getBalance(identityId)
      .then((value) => { if (!cancelled) setBalance(value) })
      .catch(() => { if (!cancelled) setBalance(null) })
    return () => {
      cancelled = true
    }
  }, [identityId, docType])

  if (!identityId || !shown || (!paused && balance === undefined)) return null
  const known = balance ?? null
  const { text, toggle } = paymentHintCopy(planPayment(docType, 'create', known, payWith), known, CREDITS_PER_DASH)

  return (
    <div data-testid="compose-payment-hint" className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span>{text}</span>
      {toggle && (
        <button
          type="button"
          onClick={() => setPayWith(payWith === 'yapp' ? 'credits' : 'yapp')}
          className="underline hover:text-yappr-600 dark:hover:text-yappr-400"
        >
          {toggle}
        </button>
      )}
    </div>
  )
}
