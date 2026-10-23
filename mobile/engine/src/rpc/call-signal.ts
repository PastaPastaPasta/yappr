import { abortedError } from '../protocol/envelope'

/**
 * The cancellation signal of the engine call being started (ENGINE.md §4.6).
 * The dispatcher sets it while it starts an API method, so a method reads it
 * with {@link callSignal} before its first `await`, and checks it between
 * its DAPI steps with {@link throwIfCancelled}: a read the host abandoned
 * stops reading. A single SDK call cannot be aborted; its result is dropped.
 */

let current: AbortSignal | undefined
const NEVER = new AbortController().signal

/** The signal of the call being started; one that never aborts outside a dispatched call (tests, the Node harness). */
export function callSignal(): AbortSignal {
  return current ?? NEVER
}

/** Run `start` (an API method's synchronous start) with `signal` as the call's signal. */
export function startWithSignal<T>(signal: AbortSignal, start: () => T): T {
  const outer = current
  current = signal
  try {
    return start()
  } finally {
    current = outer
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError()
}
