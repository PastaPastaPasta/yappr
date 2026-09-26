'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { paymentIsChoosable, planPayment } from '@/lib/payment-preference'
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
  const plan = planPayment(docType, 'create', balance, payWith)
  const feeCredits = plan.actionFee ? plan.actionFee.owner + plan.actionFee.moderators : 0n
  const fee = feeCredits > 0n ? ` + ${(Number(feeCredits) / CREDITS_PER_DASH).toFixed(4)} DASH moderation fee` : ''

  let text: string
  if (plan.payWith === 'yapp') {
    text = `Pays ${plan.yapp.toString()} YAPP${plan.gasMayBeSponsored ? ', network fee covered by Yappr' : ''}${fee}`
  } else if (plan.fallbackReason !== 'insufficient-yapp') {
    text = `Pays in credits${fee}`
  } else {
    // `null` means the balance query itself failed, not that it came back empty.
    text = `Pays in credits${balance === null ? ' (YAPP balance unavailable)' : ' (not enough YAPP)'}${fee}`
  }

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
