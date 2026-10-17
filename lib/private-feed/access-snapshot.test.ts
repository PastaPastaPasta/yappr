import { describe, expect, it } from 'vitest'
import { diffAccess, parseAccessSnapshot } from './access-snapshot'

describe('private-feed access notifications (R-S14)', () => {
  it('records the first look without announcing anything', () => {
    expect(diffAccess(null, [{ ownerId: 'b', feed: 1 }, { ownerId: 'a', feed: 2 }])).toEqual({ snapshot: ['a', 'b'], approved: [], removed: [] })
  })

  it('announces an owner who appears and one whose every grant went away', () => {
    expect(diffAccess(['a', 'b'], [{ ownerId: 'b', feed: 1 }, { ownerId: 'c', feed: 3 }, { ownerId: 'c', feed: 4 }])).toEqual({
      snapshot: ['b', 'c'], approved: [{ ownerId: 'c', feed: 4 }], removed: ['a'],
    })
  })

  it('stays quiet when a renewal moves the follower to the owner\'s next feed', () => {
    expect(diffAccess(['a'], [{ ownerId: 'a', feed: 2 }])).toEqual({ snapshot: ['a'], approved: [], removed: [] })
  })

  it('reads only a list of ids back', () => {
    expect([parseAccessSnapshot(null), parseAccessSnapshot('nope'), parseAccessSnapshot('[1]'), parseAccessSnapshot('["a"]')]).toEqual([null, null, null, ['a']])
  })
})
