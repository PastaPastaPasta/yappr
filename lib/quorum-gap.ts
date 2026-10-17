/**
 * The error of a proof the SDK could not check for want of a quorum key.
 * Dependency-free, so the SDK wrapper (`lib/services/sdk-read-retry.ts`,
 * `evo-sdk-service.ts`) can use it; `lib/error-utils.ts` re-exports it.
 */
import { extractErrorMessage } from '@/lib/error-message'

/**
 * The SDK had no key for the quorum that signed a proof, so it could not check
 * it: wasm-sdk's `QuorumKeyUnavailable`, unchanged from 5.0.0-beta.6 to rc.3
 * ("Proof verification error: quorum key unavailable for quorum 107:1c64…:
 * invalid quorum: Quorum not found in cache for hash: …", `name` `Proof`,
 * `isRetriable` true), and the older "invalid quorum" wording. It also arrives as the last error of an
 * exhausted address pool ("no available addresses to retry, last error: …").
 *
 * Transient: for ~15–20 s around every quorum rotation the trusted quorum
 * source lags the chain, and the same SDK instance recovers by itself. A read
 * that hits it is worth repeating (`lib/services/sdk-read-retry.ts`) and is
 * never an answer of "absent". A write whose RESULT hit it has an unknown outcome
 * (`isUnverifiedOutcomeError`): a create reported this way had landed on
 * sakura.
 */
export function isQuorumKeyUnavailableError(error: unknown): boolean {
  const message = extractErrorMessage(error)
  // "invalid quorum: Quorum source unavailable" is the quorum SERVICE down: an outage, not a rotation.
  if (/quorum source unavailable/i.test(message)) return false
  return /quorum key unavailable|quorum not found|invalid quorum/i.test(message)
}
