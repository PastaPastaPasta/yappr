import { describe, expect, it } from 'vitest'
import { countWithOwn } from './repost-count'

describe('countWithOwn', () => {
  it('adds the viewer\'s repost once, and takes it away once', () => {
    expect(countWithOwn({ count: 3, own: false }, true)).toBe(4)
    expect(countWithOwn({ count: 4, own: true }, false)).toBe(3)
    expect(countWithOwn({ count: 4, own: true }, true)).toBe(4)
  })

  it('leaves the true total after a repost on one card and its undo on another', () => {
    // Latest read three with no repost; Top reposts, Latest's next read finds it.
    const latest = { count: 3, own: false }
    expect(countWithOwn(latest, true)).toBe(4)
    expect(countWithOwn(latest, false)).toBe(3)
  })

  it('does not count a write twice when a refresh mid-write already includes it', () => {
    // Refreshed during the pending repost: four, read with the repost in it.
    const refreshed = { count: 4, own: true }
    expect(countWithOwn(refreshed, true)).toBe(4)
    // Refused after all: the mark rolls back.
    expect(countWithOwn(refreshed, false)).toBe(3)
  })

  it('shows the count as read while either side is unknown', () => {
    expect(countWithOwn({ count: 3 }, true)).toBe(3)
    expect(countWithOwn({ count: 3, own: true }, undefined)).toBe(3)
    expect(countWithOwn({ count: 0, own: true }, false)).toBe(0)
  })
})
