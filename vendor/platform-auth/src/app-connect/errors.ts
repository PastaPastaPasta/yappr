/**
 * Consensus errors an App Connect key ring can meet, mapped to what the app
 * should do. Callers extract the numeric code from the SDK error (the app has
 * `consensusCodeOf`) and pass it here.
 */

export type AppConnectSigningFailure =
  /** 20013: a bound key signed a non-batch transition. A routing bug; hand off to the wallet. */
  | 'bound-key-non-batch'
  /** 20014: a batch member outside the key's bounds. Paid; the selector should make it impossible. */
  | 'out-of-bounds'
  /** 20015: the key's budget is spent. */
  | 'allowance-spent'
  /** 20016: the key has expired. */
  | 'expired'
  /** 40218: this write needs more than the key has left. */
  | 'insufficient-allowance'
  /** 20006 / 40208: the key was disabled (revoked in the wallet). */
  | 'key-disabled'
  /** 20003: the key is no longer on the identity. */
  | 'key-missing'
  /** 20004 / 20007: the key's security level does not meet the transition's. */
  | 'security-level'

/**
 * `renew`: keep the session (reads continue) and ask for a new grant.
 * `logout`: the grant is gone; wipe the session.
 * `handoff`: send this one write to the wallet.
 * `invalidate`: drop cached budgets and bounds, report loudly, show a generic error.
 */
export type AppConnectFailureAction = 'renew' | 'logout' | 'handoff' | 'invalidate'

export interface AppConnectErrorClassification {
  failure: AppConnectSigningFailure
  action: AppConnectFailureAction
  /** Whether the refusal still cost fees (and so budget). */
  paid: boolean
}

const CLASSIFICATIONS: Record<number, AppConnectErrorClassification> = {
  20003: { failure: 'key-missing', action: 'logout', paid: false },
  20004: { failure: 'security-level', action: 'handoff', paid: false },
  20006: { failure: 'key-disabled', action: 'logout', paid: false },
  20007: { failure: 'security-level', action: 'handoff', paid: false },
  20013: { failure: 'bound-key-non-batch', action: 'handoff', paid: false },
  20014: { failure: 'out-of-bounds', action: 'invalidate', paid: true },
  20015: { failure: 'allowance-spent', action: 'renew', paid: false },
  20016: { failure: 'expired', action: 'renew', paid: false },
  40208: { failure: 'key-disabled', action: 'logout', paid: true },
  40218: { failure: 'insufficient-allowance', action: 'renew', paid: false },
}

/** The App Connect reading of a consensus code, or null when it is not a key-ring error. */
export function classifyAppConnectError(code: number | null | undefined): AppConnectErrorClassification | null {
  if (code === null || code === undefined) return null
  return CLASSIFICATIONS[code] ?? null
}
