'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { paymentIsChoosable, planPayment } from '@/lib/payment-preference'
import { tokenService } from '@/lib/services/token-service'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'

/**
 * What the compose is about to spend, on a contract where the user can
 * choose (v8): "10 YAPP, network fee covered" or "credits". Nothing on
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
  const plan = planPayment(docType, 'create', balance, payWith)
  const fee = plan.actionFee && plan.actionFee.moderators + plan.actionFee.owner > BigInt(0)
    ? ` + ${(Number(plan.actionFee.moderators + plan.actionFee.owner) / CREDITS_PER_DASH).toFixed(4)} DASH moderation fee`
    : ''
  const text = plan.payWith === 'yapp'
    ? `Pays ${plan.yapp.toString()} YAPP${plan.gasMayBeSponsored ? ', network fee covered by Yappr' : ''}${fee}`
    : `Pays in credits${plan.fallbackReason === 'insufficient-yapp' ? (balance === null ? ' (YAPP balance unavailable)' : ' (not enough YAPP)') : ''}${fee}`
  return (
    <div data-testid="compose-payment-hint" className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span>{text}</span>
      <button
        type="button"
        onClick={() => setPayWith(payWith === 'yapp' ? 'credits' : 'yapp')}
        className="underline hover:text-yappr-600 dark:hover:text-yappr-400"
      >
        {payWith === 'yapp' ? 'Use credits instead' : 'Use YAPP instead'}
      </button>
    </div>
  )
}
