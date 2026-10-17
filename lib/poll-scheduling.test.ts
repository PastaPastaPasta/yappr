import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollDelay, startVisibilityPolling } from './poll-scheduling'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('poll scheduling', () => {
  it('jitters ±20%, doubles failures, and caps at five minutes', () => {
    expect(pollDelay(30_000, 0, () => 0)).toBe(24_000)
    expect(pollDelay(30_000, 0, () => 1)).toBe(36_000)
    expect(pollDelay(30_000, 2, () => 0.5)).toBe(120_000)
    expect(pollDelay(30_000, 100, () => 1)).toBe(300_000)
  })

  it('pauses while hidden, catches up, backs off failures and resets after success', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const doc = Object.assign(new EventTarget(), { hidden: false })
    vi.stubGlobal('document', doc)
    const error = new Error('offline')
    const poll = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const onError = vi.fn()
    const stop = startVisibilityPolling(poll, 30_000, onError)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onError).toHaveBeenCalledWith(error)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll).toHaveBeenCalledTimes(3)
    doc.hidden = true
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(poll).toHaveBeenCalledTimes(3)
    doc.hidden = false
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(4)
    stop()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(poll).toHaveBeenCalledTimes(4)
  })

  it('does not overlap requests or schedule work after cleanup during a request', async () => {
    vi.useFakeTimers()
    const doc = Object.assign(new EventTarget(), { hidden: false })
    vi.stubGlobal('document', doc)
    let finish = () => {}
    const poll = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const stop = startVisibilityPolling(poll, 30_000, vi.fn(), true)
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(poll).toHaveBeenCalledTimes(1)
    stop()
    finish()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(poll).toHaveBeenCalledTimes(1)
  })
})
