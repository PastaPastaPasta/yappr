import { describe, expect, it, vi } from 'vitest'
import { createCountShifts, shiftedCount } from './count-shifts'

describe('count shifts', () => {
  it('shows a repost made on one card to another, and its undo there leaves the true total', () => {
    const shifts = createCountShifts()
    // Latest and Top both read three reposts.
    const latest = { count: 3, shift: shifts.get('p1') }
    const top = { count: 3, shift: shifts.get('p1') }
    shifts.shift('p1', 1) // Repost from Top.
    expect(shiftedCount(top, shifts.get('p1'))).toBe(4)
    expect(shiftedCount(latest, shifts.get('p1'))).toBe(4)
    shifts.shift('p1', -1) // Undo it from Latest.
    expect(shiftedCount(latest, shifts.get('p1'))).toBe(3)
    expect(shiftedCount(top, shifts.get('p1'))).toBe(3)
  })

  it('does not count a write twice once a newer snapshot includes it', () => {
    const shifts = createCountShifts()
    shifts.shift('p1', 1)
    const reloaded = { count: 4, shift: shifts.get('p1') }
    expect(shiftedCount(reloaded, shifts.get('p1'))).toBe(4)
    expect(shiftedCount({ count: 0, shift: 1 }, 0)).toBe(0)
  })

  it('tells subscribers, and keeps posts apart', () => {
    const shifts = createCountShifts()
    const listener = vi.fn()
    const stop = shifts.subscribe(listener)
    shifts.shift('p1', 1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(shifts.get('p2')).toBe(0)
    stop()
    shifts.shift('p1', 1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
