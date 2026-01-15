/**
 * Utility functions for error handling and message extraction.
 */

/**
 * Extracts a human-readable error message from various error formats.
 * Handles strings, Error instances, and nested error objects.
 */
export function extractErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message

  // Handle nested error objects
  const err = error as Record<string, unknown>
  if (err.message && typeof err.message === 'string') return err.message
  if (err.error) return extractErrorMessage(err.error)
  if (err.cause) return extractErrorMessage(err.cause)

  // Try to stringify, but avoid [object Object]
  try {
    const str = JSON.stringify(error)
    if (str && str !== '{}') return str.slice(0, 200)
  } catch {
    // Ignore stringify errors
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
