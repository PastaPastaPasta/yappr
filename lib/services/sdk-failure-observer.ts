/**
 * Report every rejected method call on `facades` to `onFailure` without
 * changing what the caller sees: the original rejection is rethrown as-is and
 * the operation is never repeated. Synchronous return values and streams pass
 * through untouched, and a report that throws cannot mask the failure.
 *
 * Install once per constructed SDK, after the query inspector, so its shadows
 * are what get wrapped.
 */
export function observeSdkFailures(facades: readonly object[], onFailure: (error: unknown) => void): void {
  for (const facade of facades) {
    if (!facade || typeof facade !== 'object') continue
    const prototype = Object.getPrototypeOf(facade) as object
    const names = new Set([...Object.getOwnPropertyNames(prototype), ...Object.getOwnPropertyNames(facade)])
    for (const name of names) {
      if (name === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(facade, name) ??
        Object.getOwnPropertyDescriptor(prototype, name)
      if (typeof descriptor?.value !== 'function') continue
      const original = descriptor.value as (...args: unknown[]) => unknown
      Object.defineProperty(facade, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const result = original.apply(facade, args)
          if (!isThenable(result)) return result
          return result.then(undefined, (error: unknown) => {
            try {
              onFailure(error)
            } catch {
              // The report is best-effort; the caller gets the original failure.
            }
            throw error
          })
        },
      })
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}
