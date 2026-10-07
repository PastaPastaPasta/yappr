import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchModeratedTypeOpen } from './moderated-type-gate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A team read whose answers are queued (the last repeats): `true` once a team is seated. */
function teamRead(...answers: Array<boolean | Error>) {
  return vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0]
    if (next instanceof Error) throw next
    return next as boolean
  })
}

describe('the moderated-type gate', () => {
  it('opens once the first team is seated, by polling while it is closed and without a remount', async () => {
    const read = teamRead(false, false, true)
    const seen: boolean[] = []
    const stop = watchModeratedTypeOpen(read, (open) => seen.push(open), { intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([false])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(seen).toEqual([false, false, true])
    // Open: no more polling.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(3)
    stop()
  })

  it('rereads when the window regains focus', async () => {
    const read = teamRead(false, true)
    const target = new EventTarget()
    const seen: boolean[] = []
    const stop = watchModeratedTypeOpen(read, (open) => seen.push(open), { intervalMs: 60_000, targets: [target] })
    await vi.advanceTimersByTimeAsync(0)
    target.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([false, true])
    stop()
  })

  it('keeps polling a closed gate through a failed read', async () => {
    const read = teamRead(false, new Error('offline'), true)
    const seen: boolean[] = []
    const stop = watchModeratedTypeOpen(read, (open) => seen.push(open), { intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(seen).toEqual([false, true])
    stop()
  })

  it('reads nothing after it is stopped', async () => {
    const read = teamRead(false)
    const target = new EventTarget()
    const stop = watchModeratedTypeOpen(read, () => undefined, { intervalMs: 1_000, targets: [target] })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    target.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
