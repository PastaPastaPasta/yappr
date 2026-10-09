import type { PayWith } from '@/lib/store'
import { declaredActionFee, tokenCostFor, yappIsPausedForGood, type ActionFeeDeclaration, type DocumentAction, type GasFeesPaidBy } from '@/lib/contract-topology'

/**
 * What one document write is going to cost and how it will be paid, decided
 * BEFORE signing from the contract's declarations, the user's `payWith`
 * setting and their YAPP balance. Presentation layer only: this is what the
 * compose UI shows and what the write path turns into `$tokenPaymentInfo` and
 * `$actionFeeAgreement` (`lib/transition-agreements.ts`, applied in
 * `state-transition-service.createDocument`) — see docs/SOCIAL_V8.md.
 */
export interface PaymentPlan {
  /** The currency the write spends. `credits` when the type is unpriced. */
  payWith: PayWith
  /** YAPP charged when `payWith === 'yapp'`, else 0. */
  yapp: bigint
  /**
   * The gas offer to ask for in `$tokenPaymentInfo.gasFeesPaidBy` when paying
   * in YAPP: the contract's offer (2 = PreferContractOwner on v9). Ignored when
   * paying in credits, where the signer always pays.
   */
  gasFeesPaidBy: GasFeesPaidBy
  /** True when the contract owner may end up paying the gas of this write. */
  gasMayBeSponsored: boolean
  /** The credit action fee the transition must agree to, or null. */
  actionFee: ActionFeeDeclaration | null
  /**
   * Why the plan is not what the user asked for, when it is not. `yapp-locked`:
   * the token is paused for good, and from Platform 5.0.0-beta.3 a paused
   * token cannot pay a `tokenCost` (a PAID 40711 refusal), so credits it is.
   */
  fallbackReason: 'insufficient-yapp' | 'token-required' | 'yapp-locked' | null
}

/**
 * The payment plan for a create of `docType`.
 *
 * - An unpriced type spends credits, whatever the setting.
 * - A REQUIRED token cost (every priced type on v2) spends YAPP; the
 *   setting cannot override consensus.
 * - An OPTIONAL token cost on a contract whose YAPP is paused for good
 *   ({@link yappIsPausedForGood}: v10–v13) always spends credits, whatever
 *   the setting and the balance: Platform 5.0.0-beta.3 refuses a paused
 *   token's payment with a PAID 40711.
 * - Otherwise an OPTIONAL token cost follows the setting, except that `yapp`
 *   with a balance below the cost falls back to credits: with
 *   `$tokenPaymentInfo` present an insufficient balance is a 40700 rejection,
 *   never a credits fallback, so the choice has to be made here.
 */
export function planPayment(docType: string, action: DocumentAction, balance: bigint | null, payWith: PayWith): PaymentPlan {
  const cost = tokenCostFor(docType)
  const actionFee = declaredActionFee(docType, action)
  // Credits never carry a token or a gas offer; only the reason differs.
  const inCredits = (fallbackReason: PaymentPlan['fallbackReason']): PaymentPlan => ({
    payWith: 'credits',
    yapp: 0n,
    gasFeesPaidBy: 0,
    gasMayBeSponsored: false,
    actionFee,
    fallbackReason,
  })
  if (!cost || action !== 'create') return inCredits(null)
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
  if (yappIsPausedForGood()) return inCredits(payWith === 'yapp' ? 'yapp-locked' : null)
  const canAfford = balance !== null && balance >= amount
  if (payWith === 'yapp' && canAfford) return inYapp(null)
  return inCredits(payWith === 'yapp' ? 'insufficient-yapp' : null)
}

/**
 * True when the user may choose the currency of `docType` creates at all: the
 * token cost is optional and YAPP can actually be spent.
 */
export function paymentIsChoosable(docType: string): boolean {
  return tokenCostFor(docType)?.optional === true && !yappIsPausedForGood()
}

/**
 * The compose hint for a plan: what it spends, and the label of the switch to
 * the other currency (null when there is nothing to switch to).
 *
 * The action fee is shown only when the signer pays it. Whoever pays the gas
 * pays the fee, so a sponsored YAPP write costs the user no credits at all.
 * A YAPP setting that fell back to credits offers no switch: "Use credits
 * instead" would describe what is already happening, and YAPP cannot be used.
 */
export function paymentHintCopy(plan: PaymentPlan, balance: bigint | null, creditsPerDash: number): { text: string; toggle: string | null } {
  const feeCredits = plan.actionFee ? plan.actionFee.owner + plan.actionFee.moderators : 0n
  const fee = feeCredits > 0n ? ` + ${(Number(feeCredits) / creditsPerDash).toFixed(4)} DASH moderation fee` : ''
  if (plan.payWith === 'yapp') {
    const covered = feeCredits > 0n ? 'network and moderation fees' : 'network fee'
    const text = plan.gasMayBeSponsored ? `Pays ${plan.yapp.toString()} YAPP, ${covered} covered by Yappr` : `Pays ${plan.yapp.toString()} YAPP${fee}`
    return { text, toggle: 'Use credits instead' }
  }
  // Paused YAPP cannot be spent at all: there is no other currency to offer.
  if (yappIsPausedForGood()) return { text: `Pays in credits${fee}`, toggle: null }
  if (plan.fallbackReason !== 'insufficient-yapp') return { text: `Pays in credits${fee}`, toggle: 'Use YAPP instead' }
  // `null` means the balance query itself failed, not that it came back empty.
  return { text: `Pays in credits${balance === null ? ' (YAPP balance unavailable)' : ' (not enough YAPP)'}${fee}`, toggle: null }
}
