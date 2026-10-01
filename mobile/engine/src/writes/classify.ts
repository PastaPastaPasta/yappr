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

type Rule = readonly [EngineErrorCode, retryable: boolean, matches: (error: unknown, userMessage: string) => boolean]

/** Stage 1: `categorizeError`'s chain, in its order (lib/error-utils.ts). Every code here is a consensus refusal. */
const CATEGORIZED: readonly Rule[] = [
  ['MODERATION_BARRED', false, isModerationBarredError],
  ['MODERATION_NOT_SEATED', false, isModerationNotYetSeatedError],
  ['TOO_LONG', false, isPropertyMaxBytesError],
  ['RULE_VIOLATION', false, (error, message) => message === NOT_DISTINCT_MESSAGE || isDocumentPropertyRuleError(error)],
  ['ALREADY_CLAIMED', false, isOncePerIdentityAlreadyClaimedError],
  ['PARENT_TOO_YOUNG', true, (_error, message) => message === TOO_YOUNG_MESSAGE],
  ['FEE_UNPAYABLE', false, error => isGasSponsorShortError(error) || isGasPayerError(error)],
  ['FEE_SHARE_MISMATCH', true, isModeratorsShareMismatchError],
  ['EXPIRED', false, isDocumentExpiredError],
  ['CONTEST', false, error => isContestFullError(error) || isContestFundError(error) || isContestedDocumentsNotYetAllowedError(error)],
  ['FEE_CHANGED', true, isFeeMultiplierNotToleratedError],
  ['NONCE_CONFLICT', true, isIdentityNonceConflictError],
]

/** Stage 1, after lib's three exact-message errors (handled in `classify`). */
const CATEGORIZED_TAIL: readonly Rule[] = [
  ['APP_OUTDATED', false, isActionFeeAgreementError],
  ['BUILD_DEFECT', false, (error, message) =>
    isInvalidDocumentIdError(error) ||
    isTrailingBytesError(error) ||
    isReferencedTypeNotDeletableError(error) ||
    isReferenceRequirementError(error) ||
    message === BUILD_DEFECT_MESSAGE],
  ['IMMUTABLE', false, isImmutablePropertyChangedError],
  ['TARGET_GONE', false, isReferenceNotFoundError],
  ['NOT_OWNER', false, isWriteGateError],
  ['STALE', false, isPropertyAgreementError],
  ['FROZEN', false, isFrozenBalanceError],
  ['INSUFFICIENT_YAPP', false, isInsufficientTokenError],
]

/** lib's write errors whose message is the whole signal (error-utils.ts CREATE_NOT_RECORDED_ERROR and siblings). */
const EXACT: Readonly<Record<string, readonly [EngineErrorCode, EngineErrorData['outcome']]>> = {
  [CREATE_NOT_RECORDED_ERROR]: ['NOT_RECORDED', 'not-recorded'],
  [PENDING_WRITE_ERROR]: ['PENDING_WRITE', 'not-sent'],
  [NONCE_STORE_ERROR]: ['STORAGE', 'not-sent'],
}

/**
 * Codes the engine raises itself (as `RpcError`) before or instead of lib:
 * they pass through with their own message, outcome `local`.
 */
const ENGINE_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'ABORTED', 'BAD_REQUEST', 'NOT_SUPPORTED', 'NOT_SIGNED_IN', 'NOT_RETRYABLE', 'ENGINE_RESTARTED',
  'PARENT_UNCONFIRMED', 'QUOTE_HAS_TEXT', 'PRIVATE_FEED_SYNC_REQUIRED',
])

function isConnectionFailure(message: string, error: unknown): boolean {
  return (
    evoSdkService.isConnectionError(error) ||
    message.includes('no available addresses') ||
    message.includes('Missing response message') ||
    message.includes('Network') ||
    message.includes('connection')
  )
}

/**
 * Map any write error to an engine code (ENGINE.md §7.3). Stage 1 walks
 * `categorizeError`'s predicates in its order, so a code and its user message
 * always come from the same branch. Stage 2 splits the cases
 * `categorizeError` leaves generic (duplicate, already exists, rate limit,
 * timeout, network, missing key); their `userMessage` stays web's text.
 */
export function classify(error: unknown): EngineErrorData {
  const code = readCode(error)
  if (typeof code === 'string' && ENGINE_CODES.has(code)) {
    return { code: code as EngineErrorCode, consensusCode: null, outcome: 'local', retryable: false, userMessage: extractErrorMessage(error) }
  }

  const message = extractErrorMessage(error)
  const consensusCode = consensusCodeOf(error)
  const userMessage = categorizeError(error)
  const result = (code: EngineErrorCode, outcome: EngineErrorData['outcome'], retryable: boolean): EngineErrorData =>
    ({ code, consensusCode, outcome, retryable, userMessage })

  for (const [code, retryable, matches] of CATEGORIZED) {
    if (matches(error, userMessage)) return result(code, 'refused', retryable)
  }
  const exact = EXACT[message]
  if (exact) return result(exact[0], exact[1], true)
  for (const [code, retryable, matches] of CATEGORIZED_TAIL) {
    if (matches(error, userMessage)) return result(code, 'refused', retryable)
  }

  if (isDuplicateUniqueIndexError(error)) return result('DUPLICATE', 'refused', false)
  if (isAlreadyExistsError(error)) return result('DUPLICATE', 'unknown', false)
  if (isRateLimitedError(error)) return result('RATE_LIMITED', 'not-sent', true)
  if (isTimeoutError(error)) return result('TIMEOUT', 'unknown', false)
  if (isConnectionFailure(message, error)) return result('NETWORK', 'not-sent', true)
  if (message.includes('Private key not found') || message.includes('Not logged in')) return result('NO_KEY', 'not-sent', true)
  return result('UNKNOWN', isConsensusRefusal(error) ? 'refused' : 'unknown', false)
}

/**
 * The ticket state a classified error leaves a write in: a timeout or an
 * already-exists may well have landed, so they are `unconfirmed` (check
 * again), never `failed`.
 */
export function ticketStateFor(error: EngineErrorData): Extract<WriteState, 'failed' | 'unconfirmed'> {
  return error.outcome === 'unknown' && (error.code === 'TIMEOUT' || error.code === 'DUPLICATE') ? 'unconfirmed' : 'failed'
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
