/**
 * What registering DPNS names costs, as the review step shows it and the
 * registration enforces it. Pure (unit-tested).
 *
 * Each name pays two network fees (its preorder and its domain). A contested
 * name (fewer than 20 characters of letters, hyphens, 0 and 1) also pays into
 * the community vote it starts or joins: 0.1 DASH from protocol 14, doubling
 * once a contest holds 250 contenders. That deposit is the amount the user
 * approves: the domain states it as the most it pays, and is not signed when
 * the fund read just before signing differs from it.
 */
import { formatCost } from '@/lib/moderation-charters/costs'

/**
 * What a preorder and a domain create cost when the SDK cannot price them
 * (`documentCreateCost` on DPNS at protocol 14, every index value new: about
 * 23M and 47M credits). Rounded up: they only ever size a balance check and
 * an "about" figure.
 */
export const PREORDER_FEE_FALLBACK = 25_000_000n
export const DOMAIN_FEE_FALLBACK = 50_000_000n

/** What a contested name pays into its vote, on the index it contests. */
export interface ContestFund {
  indexName: string
  credits: bigint
}

export interface DpnsNameQuote {
  label: string
  /** Null for a name that goes to no vote. */
  contestFund: ContestFund | null
  /** Network fees still to pay for this name: the preorder (unless one already landed) and the domain. */
  fees: bigint
}

export interface DpnsQuote {
  names: DpnsNameQuote[]
  contestFunds: bigint
  fees: bigint
  total: bigint
}

export function totalQuote(names: DpnsNameQuote[]): DpnsQuote {
  const contestFunds = names.reduce((sum, name) => sum + (name.contestFund?.credits ?? 0n), 0n)
  const fees = names.reduce((sum, name) => sum + name.fees, 0n)
  return { names, contestFunds, fees, total: contestFunds + fees }
}

/** "0.1 DASH (about 600¢)". */
export const formatDpnsCost = formatCost

/**
 * The deposit for `label` changed between the review and the domain's
 * signing, so the domain was not signed or sent. A preorder already paid is
 * kept for the next try.
 */
export class ContestFundChangedError extends Error {
  readonly label: string
  readonly approved: bigint | null
  readonly current: bigint
  constructor(label: string, approved: bigint | null, current: bigint) {
    super(
      approved === null
        ? `${label}.dash goes to a community vote with a ${formatDpnsCost(current)} deposit. Review the amount, then try again.`
        : `The vote deposit for ${label}.dash changed from ${formatDpnsCost(approved)} to ${formatDpnsCost(current)} since you reviewed it, so nothing more was charged. Review the new amount, then try again.`
    )
    this.name = 'ContestFundChangedError'
    this.label = label
    this.approved = approved
    this.current = current
  }
}

/**
 * The fund `label` is approved to pay, checked against the fund read right
 * before signing: the approved one when they match, else a
 * {@link ContestFundChangedError}. A name that no longer goes to a vote
 * needs no approval.
 */
export function approvedContestFund(label: string, approved: bigint | null | undefined, current: ContestFund | null): ContestFund | null {
  if (!current) return null
  if (approved === undefined || approved === null || approved !== current.credits) {
    throw new ContestFundChangedError(label, approved ?? null, current.credits)
  }
  return current
}

/** The balance a name's registration needs before its next paid step: its deposit and the fees still to pay. */
export const creditsNeeded = (quote: Pick<DpnsNameQuote, 'contestFund' | 'fees'>): bigint => (quote.contestFund?.credits ?? 0n) + quote.fees

/** The balance does not pay the next paid step (its deposit and fees), so it was not sent. */
export class BalanceTooLowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BalanceTooLowError'
  }
}

/** Why `balance` cannot pay `needed`, worded for the user, or null. */
export function shortBalanceMessage(balance: bigint, needed: bigint): string | null {
  if (balance >= needed) return null
  return `This needs ${formatDpnsCost(needed)}, and your balance is ${formatDpnsCost(balance)}. Top up, or pick a name of 20 or more characters or one with a digit from 2 to 9.`
}
