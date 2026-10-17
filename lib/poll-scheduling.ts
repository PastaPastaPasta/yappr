/** Spread polling across clients; consecutive failures double the delay up to five minutes. */
export function pollDelay(intervalMs: number, failures = 0, random = Math.random): number {
  const base = Math.min(300_000, intervalMs * 2 ** Math.min(failures, 10))
  return Math.min(300_000, Math.round(base * (0.8 + random() * 0.4)))
}

/** One request at a time, no hidden-tab work, and an immediate catch-up on return. */
export function startVisibilityPolling(
  poll: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
  immediate = false,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running = false
  let failures = 0
  const schedule = () => {
    if (!stopped && !document.hidden) timer = setTimeout(run, pollDelay(intervalMs, failures))
  }
  const run = async () => {
    if (stopped || running || document.hidden) return
    running = true
    try {
      await poll()
      failures = 0
    } catch (error) {
      failures += 1
      onError(error)
    } finally {
      running = false
      schedule()
    }
  }
  const visibility = () => {
    clearTimeout(timer)
    if (!document.hidden) run().catch(onError)
  }
  document.addEventListener('visibilitychange', visibility)
  if (immediate) run().catch(onError)
  else schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', visibility)
  }
}
