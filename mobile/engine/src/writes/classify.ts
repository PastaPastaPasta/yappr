import {
  CREATE_NOT_RECORDED_ERROR,
  NONCE_STORE_ERROR,
  PENDING_WRITE_ERROR,
  categorizeError,
  consensusCodeOf,
  extractErrorMessage,
  hasConsensusCode,
  isActionFeeAgreementError,
  isAlreadyExistsError,
  isConsensusRefusal,
  isContestFullError,
  isContestFundError,
  isContestedDocumentsNotYetAllowedError,
  isDocumentExpiredError,
  isDocumentPropertyRuleError,
  isDuplicateUniqueIndexError,
  isFeeMultiplierNotToleratedError,
  isFrozenBalanceError,
  isGasPayerError,
  isGasSponsorShortError,
  isIdentityNonceConflictError,
  isImmutablePropertyChangedError,
  isInsufficientTokenError,
  isInvalidDocumentIdError,
  isModerationBarredError,
  isModerationNotYetSeatedError,
  isModeratorsShareMismatchError,
  isOncePerIdentityAlreadyClaimedError,
  isPropertyAgreementError,
  isPropertyMaxBytesError,
  isRateLimitedError,
  isReferenceNotFoundError,
  isReferenceRequirementError,
  isReferencedTypeNotDeletableError,
  isTimeoutError,
  isTrailingBytesError,
  isWriteGateError,
} from '@/lib/error-utils'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import type { EngineErrorCode, EngineErrorData, WriteState } from './types'

/**
 * `categorizeError` messages for its three module-private predicates
 * (`isPropertyNotDistinctError`, `isReferencedDocumentTooYoungError`,
 * `isVoteChoiceNotAllowedError`). ENGINE.md §7.3 lets M7a recognise those by
 * the string they produce instead of exporting them from lib; the error
 * vectors pin these strings, so a reworded branch fails the unit tests.
 */
export const NOT_DISTINCT_MESSAGE = 'The network doesn\'t allow this combination: you can\'t do this to yourself.'
export const TOO_YOUNG_MESSAGE = 'What this depends on was only just published. Wait a minute and try again.'
export const BUILD_DEFECT_MESSAGE = 'Something went wrong building this action, so the network refused it. Nothing was charged. Please report this.'

/**
 * The error `fromBoolean` stands in for what a lib service that answers
 * `false` swallowed (`likePost`, `bookmarkPost`, `removeRepost`, ...). lib
 * answers `false` when its write threw (a refusal, a missing key, a pending
 * nonce, a failed send). Web takes `false` as failed and rolls the change
 * back, and so does the app (PRD G-4), never as a silent "may have landed". A
 * retry is safe: each of those services reads for the document before it
 * writes. The delete services (`deleteOwnPost`, `deleteOwnReply`) also answer
 * `false` for a send whose wait gave no verdict, so their `false` is decided
 * by a probe first (`fromDeleteBoolean`).
 */
export const LIB_REFUSED_MESSAGE = 'The network did not accept this change'

/**
 * Platform's refusal when the identity's credits cannot pay for the write
 * (`IdentityInsufficientBalanceError`, `BalanceIsNotEnoughError`).
 * `categorizeError` has no branch for it; the app shows PRD G-5's copy.
 */
function isInsufficientCreditsError(_error: unknown, message: string): boolean {
  return /IdentityInsufficientBalance|BalanceIsNotEnough|insufficient identity \S+ balance|credits balance \S+ is not enough to pay/i.test(message)
}

/**
 * Platform refused the key the write was signed with (PRD AUTH-14): 20006
 * `PublicKeyIsDisabledError` ("Identity key 2 is disabled"), 20003
 * `MissingPublicKeyError` ("Public key 2 doesn't exist", a key the identity
 * no longer has), 20016 `PublicKeyExpiredError`. The stored key will never
 * sign again: the account must sign in again. `categorizeError` has no
 * branch for them; the app shows the session-expired copy.
 */
function isRevokedKeyError(error: unknown, message: string): boolean {
  return hasConsensusCode(error, [20003, 20006, 20016]) ||
    /\bPublicKeyIsDisabled|\bMissingPublicKeyError|\bPublicKeyExpired|identity key \d+ is disabled|public key \d+ doesn't exist|identity public key \d+ (is )?expired at/i.test(message)
}

type Outcome = EngineErrorData['outcome']

/** `matches(error, message, userMessage)`: `message` is the error's own text, `userMessage` categorizeError's. */
type Rule = readonly [EngineErrorCode, Outcome, retryable: boolean, matches: (error: unknown, message: string, userMessage: string) => boolean]

const exactly = (text: string) => (_error: unknown, message: string) => message === text

/**
 * In order; the first match wins. Stage 1 is `categorizeError`'s chain, in its
 * order (lib/error-utils.ts), so a code and its user message always come from
 * the same branch; all but lib's three exact-message errors are consensus
 * refusals. Stage 2 splits the cases `categorizeError` leaves generic.
 */
const RULES: readonly Rule[] = [
  // Stage 1
  ['MODERATION_BARRED', 'refused', false, isModerationBarredError],
  ['MODERATION_NOT_SEATED', 'refused', false, isModerationNotYetSeatedError],
  ['TOO_LONG', 'refused', false, isPropertyMaxBytesError],
  ['RULE_VIOLATION', 'refused', false, (error, _message, userMessage) => userMessage === NOT_DISTINCT_MESSAGE || isDocumentPropertyRuleError(error)],
  ['ALREADY_CLAIMED', 'refused', false, isOncePerIdentityAlreadyClaimedError],
  ['PARENT_TOO_YOUNG', 'refused', true, (_error, _message, userMessage) => userMessage === TOO_YOUNG_MESSAGE],
  ['FEE_UNPAYABLE', 'refused', false, error => isGasSponsorShortError(error) || isGasPayerError(error)],
  ['FEE_SHARE_MISMATCH', 'refused', true, isModeratorsShareMismatchError],
  ['EXPIRED', 'refused', false, isDocumentExpiredError],
  ['CONTEST', 'refused', false, error => isContestFullError(error) || isContestFundError(error) || isContestedDocumentsNotYetAllowedError(error)],
  ['FEE_CHANGED', 'refused', true, isFeeMultiplierNotToleratedError],
  // Refused for its nonce: by another write, or by this very transition executing before an
  // SDK re-broadcast. Only a proof tells which (lib never rebuilds it), so: check, never retry blind.
  ['NONCE_CONFLICT', 'unknown', false, isIdentityNonceConflictError],
  ['NOT_RECORDED', 'not-recorded', true, exactly(CREATE_NOT_RECORDED_ERROR)],
  ['PENDING_WRITE', 'not-sent', true, exactly(PENDING_WRITE_ERROR)],
  ['STORAGE', 'not-sent', true, exactly(NONCE_STORE_ERROR)],
  ['APP_OUTDATED', 'refused', false, isActionFeeAgreementError],
  ['BUILD_DEFECT', 'refused', false, (error, _message, userMessage) =>
    isInvalidDocumentIdError(error) ||
    isTrailingBytesError(error) ||
    isReferencedTypeNotDeletableError(error) ||
    isReferenceRequirementError(error) ||
    userMessage === BUILD_DEFECT_MESSAGE],
  ['IMMUTABLE', 'refused', false, isImmutablePropertyChangedError],
  ['TARGET_GONE', 'refused', false, isReferenceNotFoundError],
  ['NOT_OWNER', 'refused', false, isWriteGateError],
  ['STALE', 'refused', false, isPropertyAgreementError],
  ['FROZEN', 'refused', false, isFrozenBalanceError],
  ['INSUFFICIENT_YAPP', 'refused', false, isInsufficientTokenError],
  // Stage 2: their userMessage stays categorizeError's generic text, for parity with web.
  ['INSUFFICIENT_CREDITS', 'refused', false, isInsufficientCreditsError],
  ['KEY_REVOKED', 'refused', false, isRevokedKeyError],
  ['UNKNOWN', 'refused', true, exactly(LIB_REFUSED_MESSAGE)],
  ['DUPLICATE', 'refused', false, isDuplicateUniqueIndexError],
  ['DUPLICATE', 'unknown', false, isAlreadyExistsError],
  ['RATE_LIMITED', 'not-sent', true, isRateLimitedError],
  ['TIMEOUT', 'unknown', false, isTimeoutError],
  // Substring rules: a refusal that carries a consensus code is Platform's verdict, whatever its prose says.
  // 'transport error' / 'Failed to fetch' / 'Load failed': wasm-sdk's gRPC-web call failing in fetch()
  // (Chromium's and WebKit's TypeError text), with or without the "no available addresses" wrapper.
  // An engine read that failed (`readFailure`) carries the code itself.
  ['NETWORK', 'not-sent', true, (error, message) => consensusCodeOf(error) === null && (
    readCode(error) === 'NETWORK' ||
    evoSdkService.isConnectionError(error) ||
    ['no available addresses', 'Missing response message', 'Network', 'connection', 'transport error', 'Failed to fetch', 'Load failed']
      .some(marker => message.includes(marker)))],
  ['NO_KEY', 'not-sent', true, (error, message) => consensusCodeOf(error) === null &&
    (message.includes('Private key not found') || message.includes('Not logged in'))],
]

/**
 * Codes the engine raises itself (as `RpcError`) before or instead of lib:
 * they pass through with their own message, outcome `local`.
 */
const ENGINE_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'ABORTED', 'BAD_REQUEST', 'NOT_SUPPORTED', 'NOT_SIGNED_IN', 'NOT_RETRYABLE', 'ENGINE_RESTARTED', 'RESTART_REQUIRED',
  'PARENT_UNCONFIRMED', 'QUOTE_HAS_TEXT', 'PRIVATE_FEED_SYNC_REQUIRED', 'STILL_BLOCKED', 'REPORT_GONE',
  'MEDIA_UNREADABLE',
])

function isEngineCode(code: unknown): code is EngineErrorCode {
  return typeof code === 'string' && ENGINE_CODES.has(code)
}

/** Map any write error to an engine code (ENGINE.md §7.3), walking `RULES` in order. */
export function classify(error: unknown): EngineErrorData {
  const message = extractErrorMessage(error)
  const code = readCode(error)
  if (isEngineCode(code)) return { code, consensusCode: null, outcome: 'local', retryable: false, userMessage: message }

  const userMessage = categorizeError(error)
  const rule = RULES.find(([, , , matches]) => matches(error, message, userMessage))
  const consensusCode = consensusCodeOf(error)
  if (!rule) return { code: 'UNKNOWN', consensusCode, outcome: isConsensusRefusal(error) ? 'refused' : 'unknown', retryable: false, userMessage }
  const [matched, outcome, retryable] = rule
  return { code: matched, consensusCode, outcome, retryable, userMessage }
}

/**
 * lib's own errors that it raises before it signs anything: the write was not
 * sent, wherever in `run()` they surface.
 */
const LIB_NOT_SENT: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>(['PENDING_WRITE', 'STORAGE', 'NO_KEY'])

/**
 * Whether a classified error is a verdict that ends a write `failed`: a
 * consensus refusal, a create proved absent, the engine's own refusal (or
 * its own reading of what lib did, as `STILL_BLOCKED`), or one of lib's
 * pre-signing errors. Anything else (a transport failure, a timeout, an
 * unrecognised error) carries no verdict: the write may have landed.
 */
export function provesNotApplied(error: EngineErrorData): boolean {
  switch (error.outcome) {
    case 'refused': case 'not-recorded': case 'local': return true
    case 'not-sent': return LIB_NOT_SENT.has(error.code)
    case 'unknown': return false
  }
}

/**
 * The ticket state a classified error leaves a write in once the write may
 * have been broadcast (the handler's `run()` is past any pre-broadcast stage):
 * `failed` only when the error proves the write never executed
 * ({@link provesNotApplied}); anything else may well have landed (a timeout,
 * an already-exists, a nonce refusal, a transport failure, an unrecognised
 * error) and is `unconfirmed` (check again), never `failed`.
 */
export function ticketStateFor(error: EngineErrorData): Extract<WriteState, 'failed' | 'unconfirmed'> {
  return provesNotApplied(error) ? 'failed' : 'unconfirmed'
}

function readCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    return (error as { code?: unknown }).code
  } catch {
    // A freed wasm error throws from its getters.
    return undefined
  }
}
