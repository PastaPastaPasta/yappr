import { useSettingsStore, type PayWith } from '@/lib/store'
import { declaredActionFee, tokenCostFor, type ActionFeeDeclaration, type DocumentAction, type GasFeesPaidBy } from '@/lib/contract-topology'

/**
 * What one document write is going to cost and how it will be paid, decided
 * BEFORE signing from the contract's declarations, the user's `payWith`
 * setting and their YAPP balance. Presentation layer only: this is what the
 * compose UI shows and what the write path (state-transition-service, after
 * the beta.3 id work lands) turns into `$tokenPaymentInfo` and
 * `$actionFeeAgreement` — see the TODO list in docs/SOCIAL_V8.md.
 */
export interface PaymentPlan {
  /** The currency the write spends. `credits` when the type is unpriced. */
  payWith: PayWith
  /** YAPP charged when `payWith === 'yapp'`, else 0. */
  yapp: bigint
  /**
   * The gas offer to ask for in `$tokenPaymentInfo.gasFeesPaidBy` when paying
   * in YAPP: the contract's offer (2 = PreferContractOwner on v8). Ignored when
   * paying in credits, where the signer always pays.
   */
  gasFeesPaidBy: GasFeesPaidBy
  /** True when the contract owner may end up paying the gas of this write. */
  gasMayBeSponsored: boolean
  /** The credit action fee the transition must agree to, or null. */
  actionFee: ActionFeeDeclaration | null
  /** Why the plan is not what the user asked for, when it is not. */
  fallbackReason: 'insufficient-yapp' | 'token-required' | null
}

/**
 * The payment plan for a create of `docType`.
 *
 * - An unpriced type spends credits, whatever the setting.
 * - A REQUIRED token cost (every priced type before v8) spends YAPP; the
 *   setting cannot override consensus.
 * - An OPTIONAL token cost follows the setting, except that `yapp` with a
 *   balance below the cost falls back to credits: with `$tokenPaymentInfo`
 *   present an insufficient balance is a 40700 rejection, never a credits
 *   fallback, so the choice has to be made here.
 */
export function planPayment(docType: string, action: DocumentAction, balance: bigint | null, payWith: PayWith): PaymentPlan {
  const cost = tokenCostFor(docType)
  const actionFee = declaredActionFee(docType, action)
  if (!cost || action !== 'create') {
    return { payWith: 'credits', yapp: 0n, gasFeesPaidBy: 0, gasMayBeSponsored: false, actionFee, fallbackReason: null }
  }
  const amount = BigInt(cost.amount)
  const inYapp = (fallbackReason: PaymentPlan['fallbackReason']): PaymentPlan => ({
    payWith: 'yapp',
    yapp: amount,
    gasFeesPaidBy: cost.gasFeesPaidBy,
    gasMayBeSponsored: cost.gasFeesPaidBy !== 0,
    actionFee,
    fallbackReason,
  })
  if (!cost.optional) return inYapp(payWith === 'credits' ? 'token-required' : null)
  const canAfford = balance !== null && balance >= amount
  if (payWith === 'yapp' && canAfford) return inYapp(null)
  return {
    payWith: 'credits',
    yapp: 0n,
    gasFeesPaidBy: 0,
    gasMayBeSponsored: false,
    actionFee,
    fallbackReason: payWith === 'yapp' ? 'insufficient-yapp' : null,
  }
}

/** True when the user may choose the currency of `docType` creates at all. */
export function paymentIsChoosable(docType: string): boolean {
  return tokenCostFor(docType)?.optional === true
}

/** The plan for the signed-in user's current setting. */
export function planPaymentForViewer(docType: string, balance: bigint | null): PaymentPlan {
  return planPayment(docType, 'create', balance, useSettingsStore.getState().payWith)
}
