import { describe, expect, it, vi } from 'vitest'
import { createCountShifts, shiftedCount, type CountBase } from './count-shifts'

describe('count shifts', () => {
  const shown = (shifts: ReturnType<typeof createCountShifts>, base: CountBase) =>
    shiftedCount(base, shifts.confirmed('p1'), shifts.pending('p1'))
  const baseOf = (shifts: ReturnType<typeof createCountShifts>, count: number): CountBase => ({ count, shift: shifts.confirmed('p1') })

  it('shows a repost made on one card to another, and its undo there leaves the true total', () => {
    const shifts = createCountShifts()
    const latest = baseOf(shifts, 3)
    const top = baseOf(shifts, 3)
    shifts.start('p1', 1).keep() // Repost from Top.
    expect(shown(shifts, top)).toBe(4)
    expect(shown(shifts, latest)).toBe(4)
    shifts.start('p1', -1).keep() // Undo it from Latest.
    expect(shown(shifts, latest)).toBe(3)
    expect(shown(shifts, top)).toBe(3)
  })

  it('keeps a card mounted mid-write right when the write is refused, or lands', () => {
    const shifts = createCountShifts()
    const latest = baseOf(shifts, 3)
    const refused = shifts.start('p1', 1)
    // Top mounts during the write with a snapshot read before it.
    const top = baseOf(shifts, 3)
    expect(shown(shifts, latest)).toBe(4)
    expect(shown(shifts, top)).toBe(4)
    refused.drop()
    expect(shown(shifts, latest)).toBe(3)
    expect(shown(shifts, top)).toBe(3)

    const landed = shifts.start('p1', 1)
    const later = baseOf(shifts, 3)
    landed.keep()
    expect(shown(shifts, later)).toBe(4)
    expect(shown(shifts, latest)).toBe(4)
  })

  it('settles a change once, whichever comes first', () => {
    const shifts = createCountShifts()
    const change = shifts.start('p1', 1)
    change.keep()
    change.drop()
    expect([shifts.confirmed('p1'), shifts.pending('p1')]).toEqual([1, 0])
  })

  it('does not count a write twice once a newer snapshot includes it', () => {
    const shifts = createCountShifts()
    shifts.apply('p1', 1)
    expect(shown(shifts, baseOf(shifts, 4))).toBe(4)
    expect(shiftedCount({ count: 0, shift: 1 }, 0, 0)).toBe(0)
  })

  it('tells subscribers, and keeps posts apart', () => {
    const shifts = createCountShifts()
    const listener = vi.fn()
    const stop = shifts.subscribe(listener)
    shifts.apply('p1', 1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(shifts.confirmed('p2')).toBe(0)
    stop()
    shifts.apply('p1', 1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
