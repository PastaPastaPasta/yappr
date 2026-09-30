/**
 * QA D-01: two writes by one identity that overlapped read the same identity
 * contract nonce and one was silently dropped. These pin the in-tab fallback
 * (Node has no Web Locks, so this is the path that runs here): writes for one
 * identity and contract never overlap, a failure does not wedge the queue, and
 * unrelated identities or contracts are not held up.
 */
import { describe, expect, it } from 'vitest'
import { withIdentityWriteLock } from './identity-write-lock'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('withIdentityWriteLock', () => {
  it('runs writes for one identity and contract one after another', async () => {
    const events: string[] = []
    const gate = deferred()
    const first = withIdentityWriteLock('alice', 'social', async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
      return 1
    })
    const second = withIdentityWriteLock('alice', 'social', async () => {
      events.push('second:start')
      return 2
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('releases the lock when a write fails', async () => {
    const failed = withIdentityWriteLock('bob', 'social', async () => {
      throw new Error('refused')
    })
    const next = withIdentityWriteLock('bob', 'social', async () => 'ran')
    await expect(failed).rejects.toThrow('refused')
    await expect(next).resolves.toBe('ran')
  })

  it('does not hold up another identity or another contract', async () => {
    const gate = deferred()
    const held = withIdentityWriteLock('carol', 'social', () => gate.promise)
    await expect(withIdentityWriteLock('dave', 'social', async () => 'other identity')).resolves.toBe('other identity')
    await expect(withIdentityWriteLock('carol', 'dm', async () => 'other contract')).resolves.toBe('other contract')
    gate.resolve()
    await held
  })
})
