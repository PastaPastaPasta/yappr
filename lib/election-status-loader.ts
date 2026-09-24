/**
 * Loads the moderation election status for a view, at most once per explicit
 * request: concurrent callers share the in-flight read, and nothing refetches
 * on its own. A view calls `load()` once on mount and again only when the user
 * asks (Refresh) — a render loop cannot turn into a DAPI loop, because only a
 * settled read can start another.
 */
export interface ElectionStatusLoader<T> {
  /** Starts a read unless one is in flight; resolves with its result. */
  load(): Promise<T>
  /** How many reads were actually started (for tests and diagnostics). */
  readonly started: number
}

export function createElectionStatusLoader<T>(read: () => Promise<T>): ElectionStatusLoader<T> {
  let inFlight: Promise<T> | null = null
  let started = 0
  return {
    load() {
      if (!inFlight) {
        started += 1
        inFlight = read().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
    get started() {
      return started
    },
  }
}
