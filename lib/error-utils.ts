/**
 * Utility functions for error handling and message extraction.
 */

const MAX_ERROR_DEPTH = 5

/**
 * Extracts a human-readable error message from various error formats.
 * Handles strings, Error instances, and nested error objects.
 * Uses depth counter to prevent infinite recursion on circular references.
 */
export function extractErrorMessage(error: unknown, depth: number = 0): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message

  // Guard against circular references or deeply nested errors
  if (depth >= MAX_ERROR_DEPTH) {
    return 'Unknown error (max depth reached)'
  }

  // Handle nested error objects
  const err = error as Record<string, unknown>
  if (err.message && typeof err.message === 'string') return err.message
  if (err.error) return extractErrorMessage(err.error, depth + 1)
  if (err.cause) return extractErrorMessage(err.cause, depth + 1)

  // Try to stringify, but avoid [object Object]
  try {
    const str = JSON.stringify(error)
    if (str && str !== '{}') return str.slice(0, 200)
  } catch {
    // Ignore stringify errors (including circular reference errors)
  }

  return 'Unknown error'
}

/**
 * Checks if an error is a timeout error that might indicate success.
 * DAPI gateway often times out even when transactions succeed.
 */
export function isTimeoutError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('deadline') ||
    msg.includes('expired') ||
    msg.includes('timed out')
  )
}

/**
 * Checks if an error indicates the state transition already exists
 * (in mempool, in chain, or nonce already used). These errors mean
 * the broadcast likely succeeded even though we didn't get confirmation.
 */
export function isAlreadyExistsError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('already in mempool') ||
    msg.includes('already in chain') ||
    msg.includes('nonce already present') ||
    msg.includes('already exists')
  )
}

/**
 * Checks if an error from waitForResponse is a non-fatal verification
 * issue that should not fail an operation whose broadcast succeeded.
 * These are typically transient network/propagation issues (e.g. a newly
 * deployed contract not yet visible to the node handling the wait request).
 */
export function isNonFatalWaitError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  // Only match the specific "unknown contract" propagation error.
  // Do NOT broadly match "document verification" or "drive error" —
  // those can indicate permanent rejections (wrong schema, bad signature, etc.).
  return msg.includes('unknown contract')
}

/**
 * Categorizes common Dash Platform errors and returns a user-friendly message.
 */
export function categorizeError(error: unknown): string {
  const errorMessage = extractErrorMessage(error)

  if (
    errorMessage.includes('no available addresses') ||
    errorMessage.includes('Missing response message')
  ) {
    return 'Dash Platform is temporarily unavailable. Please try again in a few moments.'
  }

  if (
    errorMessage.includes('Network') ||
    errorMessage.includes('connection') ||
    errorMessage.includes('timeout')
  ) {
    return 'Network error. Please check your connection and try again.'
  }

  if (
    errorMessage.includes('Private key not found') ||
    errorMessage.includes('Not logged in')
  ) {
    return 'Your session has expired. Please log in again.'
  }

  return `Failed to create post: ${errorMessage}`
}
