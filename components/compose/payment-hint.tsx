'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { paymentHintCopy, paymentIsChoosable, planPayment } from '@/lib/payment-preference'
import { tokenService } from '@/lib/services/token-service'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'

/**
 * What the compose is about to spend, on a contract where the user can
 * choose (v9): "10 YAPP, network fee covered" or "credits". Nothing on
 * contracts where the token cost is required — there is no choice to show.
 */
export function PaymentHint({ docType }: { docType: 'post' | 'reply' }) {
  const { user } = useAuth()
  const payWith = useSettingsStore((s) => s.payWith)
  const setPayWith = useSettingsStore((s) => s.setPayWith)
  // `undefined` = not fetched yet (render nothing), `null` = fetch failed.
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined)
  const identityId = user?.identityId

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

  if (!identityId || !paymentIsChoosable(docType) || balance === undefined) return null
  const { text, toggle } = paymentHintCopy(planPayment(docType, 'create', balance, payWith), balance, CREDITS_PER_DASH)

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
