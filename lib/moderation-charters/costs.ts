/**
 * What standing for election costs, as the page shows it: each write's fee
 * (priced offline from the charters contract with the SDK's
 * `documentCreateCost`), the contest deposit, and every amount in DASH and in
 * cents. Pure (unit-tested).
 */
import { CONTEST_FUND_CREDITS, LEADER_MINIMUM_CREDITS } from './rules.mjs'

export const CREDITS_PER_DASH = 100_000_000_000n
/** The reference price every cost is shown at: $60 a DASH (1M credits ≈ 0.06¢). */
export const REFERENCE_CENTS_PER_DASH = 6000

/**
 * Adding a charter key to an identity (an identity update with one key):
 * measured on testnet at about 0.0005 DASH; the page says "about".
 */
export const CHARTER_KEY_SETUP_CREDITS = 50_000_000n

/** What one create of each charters document type costs, in credits (fee only; a deposit is listed apart). */
export type CreateFees = Readonly<Record<'reason' | 'submittedCharter' | 'joinRequest' | 'electedCharter' | 'addedModerator' | 'removedModerator', bigint>>

export interface CostLine {
  label: string
  credits: bigint
  /** Paid into the masternode vote, not a fee. */
  deposit?: boolean
}

const CHARTER_KEY_LINE: CostLine = { label: 'Charter key (once per account)', credits: CHARTER_KEY_SETUP_CREDITS }

/** The lines of starting a team: new reasons, the leader's charter key (when missing) and the proposal. */
export function startCostLines(fees: CreateFees, input: { newReasons: number; needsCharterKey: boolean }): CostLine[] {
  return [
    ...(input.needsCharterKey ? [CHARTER_KEY_LINE] : []),
    ...(input.newReasons > 0 ? [{ label: input.newReasons === 1 ? 'New reason' : `${input.newReasons} new reasons`, credits: fees.reason * BigInt(input.newReasons) }] : []),
    { label: 'Proposal', credits: fees.submittedCharter },
  ]
}

/** The lines of joining a team: the member's charter key (when missing) and the request. */
export function joinCostLines(fees: CreateFees, input: { needsCharterKey: boolean }): CostLine[] {
  return [
    ...(input.needsCharterKey ? [CHARTER_KEY_LINE] : []),
    { label: 'Join request', credits: fees.joinRequest },
  ]
}

/** The lines of applying: the deposit and the application's fee. */
export function applyCostLines(fees: CreateFees): CostLine[] {
  return [
    { label: 'Contest deposit (pays for the masternode vote; not refunded)', credits: CONTEST_FUND_CREDITS, deposit: true },
    { label: 'Application', credits: fees.electedCharter },
  ]
}

export const costTotal = (lines: readonly CostLine[]): bigint => lines.reduce((sum, line) => sum + line.credits, 0n)

/** `credits` in DASH, to four significant digits below 1 ("0.0007", "0.5", "1.25"). */
export function formatDash(credits: bigint): string {
  const dash = Number(credits) / Number(CREDITS_PER_DASH)
  if (dash === 0) return '0'
  const text = dash >= 1 ? dash.toFixed(4) : dash.toPrecision(dash < 0.0001 ? 2 : 4)
  return String(Number(text))
}

/** `credits` in cents at the reference price ("about 3,000¢", "about 4.4¢", "under 0.1¢"). */
export function formatCents(credits: bigint): string {
  const cents = (Number(credits) / Number(CREDITS_PER_DASH)) * REFERENCE_CENTS_PER_DASH
  if (cents === 0) return '0¢'
  if (cents < 0.1) return 'under 0.1¢'
  if (cents >= 100) return `about ${Math.round(cents).toLocaleString('en-US')}¢`
  if (cents >= 10) return `about ${Math.round(cents)}¢`
  return `about ${cents.toFixed(1)}¢`
}

/** "0.5 DASH (about 3,000¢)". */
export const formatCost = (credits: bigint): string => `${formatDash(credits)} DASH (${formatCents(credits)})`

/** The contest deposit as the page words it: "0.5 DASH (about 3,000¢)". */
export const DEPOSIT_TEXT = formatCost(CONTEST_FUND_CREDITS)
/** What a leader needs to apply, as the page words it: "0.51 DASH (about 3,060¢)". */
export const LEADER_MINIMUM_TEXT = formatCost(LEADER_MINIMUM_CREDITS)
