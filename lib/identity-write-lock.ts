/**
 * One write at a time per identity and contract.
 *
 * Every transition an identity makes against a contract carries the next
 * identity contract nonce, and the write path reads that nonce from Platform.
 * Two writes that read it before either has executed sign the same nonce:
 * Platform accepts both broadcasts, executes one and drops the other without
 * ever reporting a result for it (QA D-01). Holding this lock from the nonce
 * read until the transition's result is known means the next write reads a
 * nonce the previous one has already consumed.
 *
 * The Web Locks API makes the lock shared by every tab of this origin, so two
 * tabs signed in as the same identity queue behind each other too. Where it is
 * missing, a queue in this tab is the fallback. Neither reaches another
 * browser or device; `stateTransitionService.createDocument` detects those
 * collisions after the fact and retries.
 *
 * Not re-entrant: a write must not start another write for the same identity
 * and contract while it holds the lock.
 */

/** The tail of each fallback queue; it settles once every write queued so far has. */
const queues = new Map<string, Promise<void>>()

function lockName(ownerId: string, contractId: string): string {
  return `yappr:identity-write:${ownerId}:${contractId}`
}

export async function withIdentityWriteLock<T>(ownerId: string, contractId: string, write: () => Promise<T>): Promise<T> {
  const name = lockName(ownerId, contractId)
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) return await locks.request(name, write)

  const run = (queues.get(name) ?? Promise.resolve()).then(write).finally(() => {
    if (queues.get(name) === tail) queues.delete(name)
  })
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(name, tail)
  return run
}
