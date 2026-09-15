import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TtlMap } from './ttl-map'

describe('TtlMap', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns a value inside the TTL and a miss after it', () => {
    const map = new TtlMap<string, number>(1000)
    map.set('a', 1)
    expect(map.get('a')).toBe(1)
    expect(map.has('a')).toBe(true)
    vi.advanceTimersByTime(999)
    expect(map.get('a')).toBe(1)
    vi.advanceTimersByTime(1)
    expect(map.get('a')).toBeUndefined()
    expect(map.has('a')).toBe(false)
  })

  it('distinguishes a stored falsy value from a miss', () => {
    const map = new TtlMap<string, boolean | null>(1000)
    map.set('f', false)
    map.set('n', null)
    expect(map.get('f')).toBe(false)
    expect(map.get('n')).toBeNull()
    expect(map.get('missing')).toBeUndefined()
  })

  it('set() restarts the clock for that key only', () => {
    const map = new TtlMap<string, number>(1000)
    map.set('a', 1)
    map.set('b', 2)
    vi.advanceTimersByTime(600)
    map.set('a', 3)
    vi.advanceTimersByTime(600)
    expect(map.get('a')).toBe(3)
    expect(map.get('b')).toBeUndefined()
  })

  it('prune() drops only expired entries', () => {
    const map = new TtlMap<string, number>(1000)
    map.set('old', 1)
    vi.advanceTimersByTime(1500)
    map.set('new', 2)
    map.prune()
    expect(map.has('old')).toBe(false)
    expect(map.get('new')).toBe(2)
  })

  it('delete() and clear() remove entries', () => {
    const map = new TtlMap<string, number>(1000)
    map.set('a', 1).set('b', 2)
    expect(map.delete('a')).toBe(true)
    expect(map.get('a')).toBeUndefined()
    map.clear()
    expect(map.get('b')).toBeUndefined()
  })
})
