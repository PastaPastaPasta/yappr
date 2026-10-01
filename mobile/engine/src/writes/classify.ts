import {
  CREATE_NOT_RECORDED_ERROR,
  NONCE_STORE_ERROR,
  PENDING_WRITE_ERROR,
  categorizeError,
  consensusCodeOf,
  extractErrorMessage,
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
  ['DUPLICATE', 'refused', false, isDuplicateUniqueIndexError],
  ['DUPLICATE', 'unknown', false, isAlreadyExistsError],
  ['RATE_LIMITED', 'not-sent', true, isRateLimitedError],
  ['TIMEOUT', 'unknown', false, isTimeoutError],
  // Substring rules: a refusal that carries a consensus code is Platform's verdict, whatever its prose says.
  ['NETWORK', 'not-sent', true, (error, message) => consensusCodeOf(error) === null && (
    evoSdkService.isConnectionError(error) ||
    ['no available addresses', 'Missing response message', 'Network', 'connection'].some(marker => message.includes(marker)))],
  ['NO_KEY', 'not-sent', true, (error, message) => consensusCodeOf(error) === null &&
    (message.includes('Private key not found') || message.includes('Not logged in'))],
]

/**
 * Codes the engine raises itself (as `RpcError`) before or instead of lib:
 * they pass through with their own message, outcome `local`.
 */
const ENGINE_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'ABORTED', 'BAD_REQUEST', 'NOT_SUPPORTED', 'NOT_SIGNED_IN', 'NOT_RETRYABLE', 'ENGINE_RESTARTED', 'RESTART_REQUIRED',
  'PARENT_UNCONFIRMED', 'QUOTE_HAS_TEXT', 'PRIVATE_FEED_SYNC_REQUIRED', 'STILL_BLOCKED',
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
 * The ticket state a classified error leaves a write in: one that may well
 * have landed (a timeout, an already-exists, a nonce refusal, a transport
 * failure after the broadcast) is `unconfirmed` (check again), never `failed`.
 * An unrecognised error stays `failed`.
 */
export function ticketStateFor(error: EngineErrorData): Extract<WriteState, 'failed' | 'unconfirmed'> {
  return error.outcome === 'unknown' && error.code !== 'UNKNOWN' ? 'unconfirmed' : 'failed'
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
