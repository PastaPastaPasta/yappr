/** The message of anything thrown, including wasm-sdk's `WasmSdkError`, which is not an `Error`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

/**
 * A gateway timeout after a broadcast: the write may still land. A consensus
 * refusal (numeric `code` 10000–99999, as `lib/error-utils.ts` reads it) is
 * final whatever its prose says.
 */
export function isTimeout(error: unknown): boolean {
  if (consensusCode(error) !== undefined) return false
  return /timeout|timed out|deadline|\b504\b/i.test(errorMessage(error))
}

/** The consensus error code (10000–99999) on the error or its cause, if any. */
export function consensusCode(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined
  const fields = error as { code?: unknown; error?: unknown; cause?: unknown }
  let code: unknown
  try {
    code = fields.code
  } catch {
    // A wasm error whose Rust side was already freed throws from its getters.
    code = undefined
  }
  if (typeof code === 'number' && code >= 10000 && code < 100000) return code
  return consensusCode(fields.error, depth + 1) ?? consensusCode(fields.cause, depth + 1)
}
