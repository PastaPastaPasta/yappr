/**
 * Reading a message out of whatever was thrown. Dependency-free, so modules
 * the SDK wrapper loads (`lib/quorum-gap.ts`) can use it; `lib/error-utils.ts`
 * re-exports it.
 */

export const MAX_ERROR_DEPTH = 5

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
