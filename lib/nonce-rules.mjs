/**
 * Drive's identity contract nonce rules (DIP-30), shared by the app
 * (lib/document-id.ts) and the Node tooling (lib/moderation-charters/
 * transitions.mjs, used by scripts/file-release-charters.mjs). Pure; types:
 * nonce-rules.d.mts.
 */

/**
 * An identity contract nonce is a u64 whose lower 40 bits are the sequence
 * number; the upper 24 bits are the missing-revision bitset Platform reports
 * back and a client must never echo.
 */
export const NONCE_SEQUENCE_MASK = (1n << 40n) - 1n

/**
 * How far from the tip Drive accepts a nonce, either way (rs-dpp
 * `MISSING_IDENTITY_REVISIONS_MAX_BYTES`): ahead of it for a new transition,
 * behind it for one filling a gap.
 */
export const MAX_NONCE_DISTANCE = 24n

/**
 * Whether `nonce` can no longer be used, given the raw value
 * `identities.contractNonce` returned: it is the tip, it was filled in behind
 * the tip, or it has fallen out of the window behind the tip. A nonce behind
 * the tip whose missing bit is still set can execute yet. Mirrors Drive's
 * `validate_identity_nonce_update`.
 */
export function identityContractNonceConsumed(current, nonce) {
  const raw = BigInt(current ?? 0)
  const wanted = BigInt(nonce)
  const tip = raw & NONCE_SEQUENCE_MASK
  if (wanted > tip) return false
  const behind = tip - wanted
  if (behind === 0n || behind > MAX_NONCE_DISTANCE) return true
  // Bit 40 + (behind - 1) is set while that nonce is still missing.
  return (raw & (1n << (40n + behind - 1n))) === 0n
}
