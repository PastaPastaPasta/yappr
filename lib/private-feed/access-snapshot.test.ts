import { describe, expect, it } from 'vitest'
import { diffAccess, newestPerOwner, ownersToCheck, parseAccessSnapshot, REVOKE_CHECK_MS, type AccessSnapshot } from './access-snapshot'

const grants = (...list: [string, number, string][]) => newestPerOwner(list.map(([ownerId, feed, grantId]) => ({ ownerId, feed, grantId })))
const none = new Map<string, boolean>()

describe('private-feed access notifications (R-S14)', () => {
  it('records the first look without announcing anything', () => {
    const diff = diffAccess(null, grants(['b', 1, 'g1'], ['a', 2, 'g2']), none, 0)
    expect([diff.approved, diff.removed, Object.keys(diff.snapshot).sort()]).toEqual([[], [], ['a', 'b']])
  })

  it('announces a new owner, and one whose every grant went away', () => {
    const previous: AccessSnapshot = { a: { g: 'ga', r: false, t: 0 }, b: { g: 'gb', r: false, t: 0 } }
    const diff = diffAccess(previous, grants(['b', 1, 'gb'], ['c', 3, 'gc3'], ['c', 4, 'gc4']), new Map([['c', false]]), 5)
    expect([diff.approved, diff.removed]).toEqual([[{ ownerId: 'c', feed: 4, grantId: 'gc4' }], ['a']])
  })

  it('announces a removal when the kept grant turns revoked, and the re-approval after it', () => {
    const before: AccessSnapshot = { a: { g: 'ga', r: false, t: 0 } }
    const removed = diffAccess(before, grants(['a', 1, 'ga']), new Map([['a', true]]), REVOKE_CHECK_MS)
    expect(removed.removed).toEqual(['a'])
    const back = diffAccess(removed.snapshot, grants(['a', 1, 'ga2']), new Map([['a', false]]), REVOKE_CHECK_MS + 1)
    expect(back.approved).toEqual([{ ownerId: 'a', feed: 1, grantId: 'ga2' }])
  })

  it('stays quiet when a renewal moves the follower to the owner\'s next feed', () => {
    const diff = diffAccess({ a: { g: 'g1', r: false, t: 0 } }, grants(['a', 2, 'g2']), new Map([['a', false]]), 1)
    expect([diff.approved, diff.removed]).toEqual([[], []])
  })

  it('re-checks a grant in force only when it changed or the check is stale', () => {
    const previous: AccessSnapshot = { a: { g: 'ga', r: false, t: 0 }, b: { g: 'gb', r: true, t: 0 }, c: { g: 'gc', r: false, t: 100 } }
    expect(ownersToCheck(previous, grants(['a', 1, 'ga'], ['b', 1, 'gb'], ['c', 1, 'gc2'], ['d', 1, 'gd']), 50)).toEqual(['c', 'd'])
    expect(ownersToCheck(previous, grants(['a', 1, 'ga']), REVOKE_CHECK_MS)).toEqual(['a'])
  })

  it('reads only a well-formed snapshot back', () => {
    expect([parseAccessSnapshot(null), parseAccessSnapshot('nope'), parseAccessSnapshot('["a"]'), parseAccessSnapshot('{"a":{"g":1}}')]).toEqual([null, null, null, null])
    expect(parseAccessSnapshot('{"a":{"g":"x","r":false,"t":1}}')).toEqual({ a: { g: 'x', r: false, t: 1 } })
  })
})
