/**
 * The vote deposit a contested DPNS name pays, as the review shows it and the
 * registration enforces it. From protocol 14 a contested domain states the
 * most it pays into its vote (`contestFund`), and the fund to join doubles once
 * a contest holds 250 contenders and again for every 50 more. Yappr states the
 * deposit the user approved, and signs nothing when the deposit read right
 * before signing is more than that. Pure (scripts/contest-deposit.test.mjs).
 */

const CREDITS_PER_DASH = BigInt(100_000_000_000)

/** "0.1 DASH" for credits (11 decimals, trailing zeros dropped). */
export function formatDeposit(credits: bigint): string {
  const whole = credits / CREDITS_PER_DASH
  const fraction = (credits % CREDITS_PER_DASH).toString().padStart(11, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''} DASH`
}

/** The deposit for `label` rose (or was never shown) after the review, so nothing was signed. */
export class DepositChangedError extends Error {
  readonly label: string
  readonly approved: bigint | null
  readonly current: bigint

  constructor(label: string, approved: bigint | null, current: bigint) {
    super(
      approved === null
        ? `${label}.dash goes to a community vote with a ${formatDeposit(current)} deposit. Review the amount, then try again.`
        : `The vote deposit for ${label}.dash went up from ${formatDeposit(approved)} to ${formatDeposit(current)} since you reviewed it, so nothing was charged. Review the new amount, then try again.`
    )
    this.name = 'DepositChangedError'
    this.label = label
    this.approved = approved
    this.current = current
  }
}

/** Shown on a contested name whose deposit could not be read; checking again retries it. */
export const DEPOSIT_UNREADABLE_MESSAGE = 'Could not read the vote deposit for this name. Go back and check it again.'

/**
 * Whether Platform refused a contested domain for stating less than the fund
 * to join (40114): the deposit rose after the preorder, and was not paid.
 */
export function contestNotPaidFor(error: unknown): boolean {
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : {}
  if (fields.code === 40114) return true
  const message = typeof fields.message === 'string' ? fields.message : String(error)
  return /\b40114\b|DocumentContestNotPaidFor|contest for document .* was not paid for/i.test(message)
}

/**
 * The name a registration batch grants the user now: the first non-contested
 * success. A contested one has only joined its vote, so it never becomes the
 * session's username (nor replaces one the user owns); null leaves it as is.
 */
export function grantedUsername(results: ReadonlyArray<{ label: string; success: boolean; isContested: boolean }>): string | null {
  return results.find((result) => result.success && !result.isContested)?.label ?? null
}

/**
 * The most `label`'s domain may pay into its vote: the approved deposit, when
 * the deposit read now (`current`, null for a name that goes to no vote) is not
 * more than it. Throws {@link DepositChangedError} otherwise.
 */
export function depositCap(label: string, approved: bigint | null | undefined, current: bigint | null): bigint | null {
  if (current === null) return null
  if (approved === null || approved === undefined || current > approved) {
    throw new DepositChangedError(label, approved ?? null, current)
  }
  return approved
}
