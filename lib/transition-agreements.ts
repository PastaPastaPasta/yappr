import type { DocumentActionFeeAgreementOptions, TokenPaymentInfoOptions } from '@dashevo/wasm-sdk'
import type { ActionFeeDeclaration } from '@/lib/contract-topology'
import type { PaymentPlan } from '@/lib/payment-preference'

/**
 * The option bags a document create carries on protocol 14, built from the
 * contract's declarations and the viewer's payment plan. Pure: the write path
 * (`state-transition-service.ts`) and its tests share these, and the wasm
 * constructors (`DocumentActionFeeAgreement`, `TokenPaymentInfo`) are applied
 * to the result at the call site.
 */

/**
 * How far above the multiplier the signer knew the executing epoch's may be,
 * in percent: 20 accepts up to 1.2x. A transition signed just before an epoch
 * boundary is then not refused for a small move (40134 otherwise).
 */
export const FEE_MULTIPLIER_TOLERANCE_PERCENT = 20

/** The multiplier assumed when the epoch read fails: 1000 permille is 1.0x, today's devnet value. */
export const DEFAULT_FEE_MULTIPLIER_PERMILLE = 1000n

/**
 * The `$actionFeeAgreement` for an action the contract prices. The amounts are
 * the declared ones, each pot on its own — anything else is 40133 — and the
 * moderators part is never discounted: on an elected contract a lower amount
 * must equal the seated charter's share exactly (40139), while the full
 * declared amount is accepted whether or not a charter is seated. And
 * `feeMultiplier` is named only for `feeMultiplier` pricing (naming it for a
 * `fixed` fee is the same mismatch).
 */
export function actionFeeAgreementOptions(fee: ActionFeeDeclaration, knownPermille: bigint): DocumentActionFeeAgreementOptions {
  return {
    owner: fee.owner,
    moderators: fee.moderators,
    ...(fee.pricing === 'feeMultiplier'
      ? { feeMultiplier: { knownPermille, increaseTolerancePercent: FEE_MULTIPLIER_TOLERANCE_PERCENT } }
      : {}),
  }
}

/**
 * The `$tokenPaymentInfo` a plan calls for, or undefined when the write spends
 * credits: on an `optional` token cost (v9) leaving the payment info out is
 * what makes the signer pay credits, and payment info present with too little
 * YAPP is a 40700 refusal rather than a fallback.
 *
 * The gas offer is only named when the contract offers one (2 =
 * PreferContractOwner on v9). On v2 the bag is exactly what it always was:
 * position and cap, the signer paying the gas. `1` (ContractOwner, insisting)
 * is never asked for: the type offers `2`, and insisting is 40129.
 */
export function tokenPaymentOptions(plan: PaymentPlan, tokenContractPosition: number): TokenPaymentInfoOptions | undefined {
  if (plan.payWith !== 'yapp') return undefined
  return {
    tokenContractPosition,
    maximumTokenCost: plan.yapp,
    ...(plan.gasFeesPaidBy !== 0 ? { gasFeesPaidBy: plan.gasFeesPaidBy } : {}),
  }
}
