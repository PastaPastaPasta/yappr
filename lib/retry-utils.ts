import { logger } from '@/lib/logger';
import { extractErrorMessage } from '@/lib/error-utils';
/**
 * Retry utility functions for handling network errors and transient failures
 */

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  retryCondition?: (error: unknown) => boolean
}

export interface RetryResult<T> {
  success: boolean
  data?: T
  error?: Error
  attempts: number
}

/**
 * Default retry condition - retries on network errors and temporary failures
 */
function defaultRetryCondition(error: unknown): boolean {
  if (!error) return false

  const errorText = getErrorText(error)

  // Network-related errors
  const networkErrors = [
    'network error',
    'network request failed',
    'fetch failed',
    'connection refused',
    'timeout',
    'timed out',
    'deadline',
    'etimedout',
    'enotfound',
    'econnreset',
    'econnrefused',
    'missing response message',
    'transport error',
    'grpc error'
  ]

  // Check if it's a retryable error
  return networkErrors.some(networkError =>
    errorText.includes(networkError)
  )
}

/**
 * Build a lowercase text representation of an error for message matching.
 * Combines the extracted message with the error's string form so that
 * non-Error objects and wrapped errors are still classified correctly.
 */
function getErrorText(error: unknown): string {
  const message = extractErrorMessage(error)
  let stringified = ''
  try {
    stringified = String(error)
  } catch {
    // Ignore objects whose toString throws
  }
  return `${message} ${stringified}`.toLowerCase()
}

/**
 * Thrown when a post/reply broadcast outcome is unknown: the state transition
 * was sent (or may have been sent) to Platform, but neither success nor
 * failure could be confirmed and the document could not be found afterwards.
 *
 * This error is deliberately NON-retryable: re-running the create would build
 * a new document with fresh entropy (and, for private posts, a fresh nonce),
 * which risks creating a duplicate if the original transition later commits.
 */
export class PostCreationIndeterminateError extends Error {
  readonly documentType: string
  readonly documentId: string

  constructor(documentType: string, documentId: string, cause?: unknown) {
    super(
      `Your ${documentType} may have been created (document ${documentId}), but Platform did not confirm it. ` +
      `Check your profile before trying again to avoid posting a duplicate.`
    )
    this.name = 'PostCreationIndeterminateError'
    this.documentType = documentType
    this.documentId = documentId
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause
    }
    // Restore prototype chain for environments that transpile class extends
    Object.setPrototypeOf(this, PostCreationIndeterminateError.prototype)
  }
}

/**
 * Type guard for PostCreationIndeterminateError that also tolerates
 * duplicate module instances from bundling by falling back to the name.
 */
export function isPostCreationIndeterminateError(error: unknown): error is PostCreationIndeterminateError {
  if (error instanceof PostCreationIndeterminateError) return true
  return error instanceof Error && error.name === 'PostCreationIndeterminateError'
}

/**
 * Check whether a post creation error is ambiguous: the broadcast may have
 * actually succeeded even though an error was reported. Covers network and
 * timeout failures plus Dash Platform availability errors.
 */
export function isPostCreationAmbiguousError(error: unknown): boolean {
  if (defaultRetryCondition(error)) return true

  const errorText = getErrorText(error)

  const dashErrors = [
    'internal error',
    'temporarily unavailable',
    'service unavailable',
    'consensus error',
    'quorum not available',
    'tenderdash is not available',
    'tenderdash not available'
  ]

  return dashErrors.some(dashError => errorText.includes(dashError))
}

/**
 * Check whether an error PROVES the state transition was rejected by
 * Platform (validation/consensus rejection), meaning the document was
 * definitely NOT created.
 *
 * This list is intentionally narrow. It gates the ambiguity handling after a
 * broadcast was attempted: anything NOT in this list is treated as ambiguous
 * (the transition may still commit), because wrongly calling an outcome
 * "definite failure" invites the user to rebroadcast and create a duplicate,
 * while wrongly calling it "ambiguous" only costs a "check your profile"
 * prompt.
 */
export function isDefiniteRejectionError(error: unknown): boolean {
  const errorText = getErrorText(error)

  const rejectionErrors = [
    'state transition is invalid',
    'invalid state transition',
    'validation error',
    'validation failed',
    'schema validation',
    'invalid document',
    'document type not found',
    'missing required property',
    'invalid signature',
    'signature verification',
    'insufficient balance',
    'balance is not enough',
    'not enough balance'
  ]

  return rejectionErrors.some(rejection => errorText.includes(rejection))
}

/**
 * Exponential backoff with jitter
 */
function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number, backoffMultiplier: number): number {
  const delay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs)
  // Add jitter (±25% random variation)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.max(0, delay + jitter)
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryCondition = defaultRetryCondition
  } = options

  let lastError: Error | undefined
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Retry attempt ${attempt}/${maxAttempts}`)
      const result = await operation()
      logger.info(`Operation succeeded on attempt ${attempt}`)
      
      return {
        success: true,
        data: result,
        attempts: attempt
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      logger.warn(`Attempt ${attempt} failed:`, lastError.message)
      
      // Don't retry if this is the last attempt or if error is not retryable
      if (attempt === maxAttempts || !retryCondition(lastError)) {
        logger.info(attempt === maxAttempts ? 'Max attempts reached' : 'Error not retryable')
        break
      }
      
      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier)
      logger.info(`Waiting ${Math.round(delay)}ms before retry...`)
      await sleep(delay)
    }
  }
  
  return {
    success: false,
    error: lastError,
    attempts: maxAttempts
  }
}

/**
 * Specialized retry for post creation with Dash Platform specific error handling
 */
export async function retryPostCreation<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<RetryResult<T>> {
  return retryAsync(operation, {
    maxAttempts: 3,
    initialDelayMs: 2000,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    retryCondition: (error) => {
      // Ambiguous outcomes are terminal: the original document may still commit
      // on Platform, and re-running the create callback would broadcast a NEW
      // document (fresh entropy → fresh ID → duplicate). The service layer only
      // throws PostCreationIndeterminateError after exact-ID recovery has
      // already been attempted, so never retry it.
      if (isPostCreationIndeterminateError(error)) return false

      // Everything else that matches the ambiguous classifier is a definite
      // PRE-broadcast failure at this point (post/reply services convert
      // post-broadcast ambiguous failures into PostCreationIndeterminateError),
      // so retrying cannot double-post.
      return isPostCreationAmbiguousError(error)
    },
    ...options
  })
}

/**
 * Check if an error appears to be a network error
 */
export function isNetworkError(error: unknown): boolean {
  return defaultRetryCondition(error)
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  return defaultRetryCondition(error)
}