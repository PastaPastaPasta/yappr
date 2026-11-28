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

/**
 * What deleting an expiring DPNS v3 preorder costs, rounded up (the SDK prices
 * no deletes yet, platform#5265).
 */
export const PREORDER_DELETE_FEE = 20_000_000n

/**
 * The balance a DPNS v3 (protocol 15) domain create must find before Drive
 * admits it, beyond what it is charged: its preorder reference reserves for
 * the `chooseFirst` scan. Observed at about 232M credits (platform#6340); no
 * SDK function reports it yet (platform#5265, #6337), so this is a
 * conservative floor checked before the preorder is paid.
 */
export const DOMAIN_ADMISSION_FLOOR = 300_000_000n

/** The paid steps a quote counted, and so the only ones the registration may sign anew. */
export interface DpnsRegistrationPlan {
  preorder: boolean
  deletePreorder: boolean
  domain: boolean
}

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
  /** Balance the domain must find beyond its fees to be admitted (protocol 15), charged to no one. */
  reserve?: bigint
  /** The fee of re-sending a preorder that was sent and never confirmed: charged only if it has to be sent again. */
  resendFee?: bigint
  /** The paid steps besides the domain this quote counted. */
  plan?: DpnsRegistrationPlan
}

export interface DpnsQuote {
  names: DpnsNameQuote[]
  contestFunds: bigint
  fees: bigint
  /** What the names are expected to cost. */
  total: bigint
  /** Fees charged only if unconfirmed preorders have to be sent again: each name's can be. */
  resendFees: bigint
  /** The balance needed before anything is paid: the total, every possible re-send fee, and the largest admission reserve. */
  needed: bigint
}

export function totalQuote(names: DpnsNameQuote[]): DpnsQuote {
  const contestFunds = names.reduce((sum, name) => sum + (name.contestFund?.credits ?? 0n), 0n)
  const fees = names.reduce((sum, name) => sum + name.fees, 0n)
  const resendFees = names.reduce((sum, name) => sum + (name.resendFee ?? 0n), 0n)
  const reserve = names.reduce((most, name) => ((name.reserve ?? 0n) > most ? (name.reserve ?? 0n) : most), 0n)
  const total = contestFunds + fees
  return { names, contestFunds, fees, total, resendFees, needed: total + resendFees + reserve }
}

/**
 * Registering `label` now needs a paid step the review did not show (its
 * preorder expired, say), so nothing was sent: quote it again.
 */
export class RegistrationPlanChangedError extends Error {
  readonly label: string
  constructor(label: string) {
    super(`Registering ${label}.dash now needs another network fee that wasn't in your review, so nothing was charged. Review the new amount, then try again.`)
    this.name = 'RegistrationPlanChangedError'
    this.label = label
  }
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

/** The balance a name's registration needs before its next paid step: its deposit, the fees still to pay and any re-send fee. */
export const creditsNeeded = (quote: Pick<DpnsNameQuote, 'contestFund' | 'fees' | 'reserve' | 'resendFee'>): bigint =>
  (quote.contestFund?.credits ?? 0n) + quote.fees + (quote.resendFee ?? 0n) + (quote.reserve ?? 0n)

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
