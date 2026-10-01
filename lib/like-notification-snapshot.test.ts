import { describe, expect, it } from 'vitest'
import { applyLikeObservations, parseLikeSnapshot, targetsToRead, type KindObservation, type LikeSnapshot } from './like-notification-snapshot'

const ME = 'me'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** Recent targets and their counts; each created at `at[target]`, NOW by default. */
const counts = (entries: Record<string, number>, at: Record<string, number> = {}) =>
  new Map(Object.entries(entries).map(([target, count]) => [target, { count, createdAtMs: at[target] ?? NOW }]))
const read = (entries: Record<string, string[]>, complete = true) =>
  new Map(Object.entries(entries).map(([target, likers]) => [target, { likers, complete }]))
const observe = (kind: 'post' | 'reply', c: Record<string, number>, l: Record<string, string[]> = {}, complete = true, at: Record<string, number> = {}): KindObservation =>
  ({ kind, targets: counts(c, at), likers: read(l, complete) })

/** A snapshot whose post kind is baselined on P1 liked by alice and bob. */
function baselined(): LikeSnapshot {
  return applyLikeObservations(null, [observe('post', { P1: 2, P2: 0 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW - 60_000 }).snapshot
}

describe('first poll on a device', () => {
  it('records every liked target as the baseline and notifies nothing', () => {
    expect(targetsToRead(null, 'post', counts({ P1: 2, P2: 0 }))).toEqual(['P1'])

    const { snapshot, fresh } = applyLikeObservations(null, [observe('post', { P1: 2, P2: 0 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW })

    expect(fresh).toEqual([])
    expect(snapshot).toEqual({ v: 1, baselined: ['post'], horizons: { post: NOW }, targets: { 'post:P1': { count: 2, likers: ['alice', 'bob'] } }, batches: [] })
  })

  it('baselines a kind silently even when another kind already has one', () => {
    const { fresh, snapshot } = applyLikeObservations(baselined(), [observe('reply', { R1: 1 }, { R1: ['carol'] })], { selfId: ME, nowMs: NOW })

    expect(fresh).toEqual([])
    expect(snapshot.baselined.sort()).toEqual(['post', 'reply'])
    // The post kind was not observed: carried over untouched.
    expect(snapshot.targets['post:P1']).toEqual({ count: 2, likers: ['alice', 'bob'] })
  })
})

describe('later polls', () => {
  it('reads only targets whose count moved, a fall included', () => {
    expect(targetsToRead(baselined(), 'post', counts({ P1: 2, P2: 0, P3: 1 }))).toEqual(['P3'])
    expect(targetsToRead(baselined(), 'post', counts({ P1: 1 }))).toEqual(['P1'])
  })

  it('aggregates the new likers of one target into one batch with a stable id, leaving out the user', () => {
    const { fresh, snapshot } = applyLikeObservations(baselined(), [
      observe('post', { P1: 5, P2: 0 }, { P1: ['alice', 'bob', 'carol', ME, 'dave'] }),
    ], { selfId: ME, nowMs: NOW })

    expect(fresh).toEqual([{ id: `like:post:P1:${NOW}`, kind: 'post', targetId: 'P1', firstSeenMs: NOW, likers: ['carol', 'dave'], total: 2 }])
    expect(snapshot.batches).toEqual(fresh)
    expect(snapshot.targets['post:P1']).toEqual({ count: 5, likers: ['alice', 'bob', 'carol', ME, 'dave'] })
  })

  it('notifies every liker of a newly liked target', () => {
    const { fresh } = applyLikeObservations(baselined(), [observe('post', { P1: 2, P3: 1 }, { P3: ['erin'] })], { selfId: ME, nowMs: NOW })

    expect(fresh.map(({ targetId, likers }) => ({ targetId, likers }))).toEqual([{ targetId: 'P3', likers: ['erin'] }])
  })

  it('keeps an unchanged target, drops one that left the recent window or lost every like, and notifies nothing for an unlike', () => {
    const start = applyLikeObservations(baselined(), [observe('post', { P1: 2, P4: 1 }, { P4: ['frank'] })], { selfId: ME, nowMs: NOW }).snapshot

    const { fresh, snapshot } = applyLikeObservations(start, [observe('post', { P1: 1, P4: 0 }, { P1: ['alice'] })], { selfId: ME, nowMs: NOW + 1 })

    expect(fresh).toEqual([])
    expect(snapshot.targets).toEqual({ 'post:P1': { count: 1, likers: ['alice'] } })
    // A re-like by bob is new again.
    const relike = applyLikeObservations(snapshot, [observe('post', { P1: 2 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW + 2 })
    expect(relike.fresh.map((batch) => batch.likers)).toEqual([['bob']])
  })

  it('stops naming likers of a target too big to read whole, until a complete read re-baselines it', () => {
    const big = applyLikeObservations(baselined(), [observe('post', { P1: 900 }, { P1: ['alice'] }, false)], { selfId: ME, nowMs: NOW })
    expect(big.fresh).toEqual([])
    expect(big.snapshot.targets['post:P1']).toEqual({ count: 900, likers: null })

    const back = applyLikeObservations(big.snapshot, [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'zed'] })], { selfId: ME, nowMs: NOW + 1 })
    expect(back.fresh).toEqual([])
    expect(back.snapshot.targets['post:P1']).toEqual({ count: 3, likers: ['alice', 'bob', 'zed'] })
  })

  it('caps the likers named in a batch but keeps the total', () => {
    const crowd = Array.from({ length: 25 }, (_, i) => `u${i}`)
    const { fresh } = applyLikeObservations(baselined(), [observe('post', { P1: 27 }, { P1: ['alice', 'bob', ...crowd] })], { selfId: ME, nowMs: NOW })

    expect(fresh[0].likers).toHaveLength(10)
    expect(fresh[0].total).toBe(25)
  })

  it('reads at most ten targets a poll, newest first, and finishes a baseline over later polls before notifying', () => {
    const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`T${i}`, 1]))
    const likersOf = (targets: string[]) => Object.fromEntries(targets.map((target) => [target, [`fan-${target}`]]))

    const first = targetsToRead(null, 'post', counts(many))
    expect(first).toEqual(Object.keys(many).slice(0, 10))
    const partial = applyLikeObservations(null, [observe('post', many, likersOf(first))], { selfId: ME, nowMs: NOW })
    expect(partial.snapshot.baselined).toEqual([])

    const rest = targetsToRead(partial.snapshot, 'post', counts(many))
    expect(rest).toEqual(['T10', 'T11', 'T12', 'T13'])
    const done = applyLikeObservations(partial.snapshot, [observe('post', many, likersOf(rest))], { selfId: ME, nowMs: NOW + 1 })
    expect(done.fresh).toEqual([])
    expect(done.snapshot.baselined).toEqual(['post'])
    expect(Object.keys(done.snapshot.targets)).toHaveLength(14)
  })

  it('carries a moved target the cap left unread at its old count, so the next poll reads it', () => {
    const start = baselined()
    const { snapshot, fresh } = applyLikeObservations(start, [observe('post', { P1: 3 })], { selfId: ME, nowMs: NOW })

    expect(fresh).toEqual([])
    expect(snapshot.targets['post:P1']).toEqual({ count: 2, likers: ['alice', 'bob'] })
    expect(targetsToRead(snapshot, 'post', counts({ P1: 3 }))).toEqual(['P1'])
  })

  it('records a target re-entering the window from below its previous horizon silently', () => {
    // The window was P1 (NOW) and P2 (NOW - DAY); OLD, created before both, was outside it.
    const start = applyLikeObservations(null, [observe('post', { P1: 1, P2: 0 }, { P1: ['alice'] }, true, { P2: NOW - DAY })], { selfId: ME, nowMs: NOW }).snapshot
    expect(start.horizons).toEqual({ post: NOW - DAY })

    // P2 is deleted, OLD slides back in with its likes, and NEW is a fresh post.
    const { fresh, snapshot } = applyLikeObservations(start, [
      observe('post', { NEW: 1, P1: 1, OLD: 3 }, { NEW: ['erin'], OLD: ['x', 'y', 'z'] }, true, { NEW: NOW + 1, OLD: NOW - 2 * DAY }),
    ], { selfId: ME, nowMs: NOW + 1 })

    expect(fresh.map(({ targetId, likers }) => ({ targetId, likers }))).toEqual([{ targetId: 'NEW', likers: ['erin'] }])
    expect(snapshot.targets['post:OLD']).toEqual({ count: 3, likers: ['x', 'y', 'z'] })
    expect(snapshot.horizons).toEqual({ post: NOW - 2 * DAY })
  })

  it('does not forget a liker a lagging read left out, so they are not announced again', () => {
    // Count 3, but the read (another node) lists alice and carol only: carol is new, bob is kept.
    const lagging = applyLikeObservations(baselined(), [observe('post', { P1: 3 }, { P1: ['alice', 'carol'] })], { selfId: ME, nowMs: NOW })
    expect(lagging.fresh.map((batch) => batch.likers)).toEqual([['carol']])
    // Fewer likers than the count: the smaller count is stored, so the next poll reads again.
    expect(lagging.snapshot.targets['post:P1']).toEqual({ count: 2, likers: ['alice', 'bob', 'carol'] })
    expect(targetsToRead(lagging.snapshot, 'post', counts({ P1: 3 }))).toEqual(['P1'])

    const caughtUp = applyLikeObservations(lagging.snapshot, [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW + 1 })
    expect(caughtUp.fresh).toEqual([])
    expect(caughtUp.snapshot.targets['post:P1']).toEqual({ count: 3, likers: ['alice', 'bob', 'carol'] })
  })

  it('does not replace the likers on a fall with a read that cannot cover the new count', () => {
    // Baseline alice, bob and carol; carol unlikes (count 2) but the read is a block behind and lists alice only.
    const start = applyLikeObservations(null, [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW }).snapshot
    const lagging = applyLikeObservations(start, [observe('post', { P1: 2 }, { P1: ['alice'] })], { selfId: ME, nowMs: NOW + 1 })
    expect(lagging.fresh).toEqual([])
    expect(lagging.snapshot.targets['post:P1']).toEqual({ count: 1, likers: ['alice', 'bob', 'carol'] })
    // The next read is current: bob was known all along, so nothing is announced.
    const current = applyLikeObservations(lagging.snapshot, [observe('post', { P1: 2 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW + 2 })
    expect(current.fresh).toEqual([])
    // The lagging read stored count 1, so this one is a rise and merges: carol stays known.
    expect(current.snapshot.targets['post:P1']).toEqual({ count: 2, likers: ['alice', 'bob', 'carol'] })
  })

  it('announces a liker whose count arrived before the likers did, on the next read', () => {
    const early = applyLikeObservations(baselined(), [observe('post', { P1: 3 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW })
    expect(early.fresh).toEqual([])

    const { fresh } = applyLikeObservations(early.snapshot, [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW + 1 })
    expect(fresh.map((batch) => batch.likers)).toEqual([['carol']])
  })

  it('does not name again a liker a retained batch named, after an unlike and re-like', () => {
    const liked = applyLikeObservations(baselined(), [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW }).snapshot
    const unliked = applyLikeObservations(liked, [observe('post', { P1: 2 }, { P1: ['alice', 'bob'] })], { selfId: ME, nowMs: NOW + 1 }).snapshot
    expect(unliked.targets['post:P1']).toEqual({ count: 2, likers: ['alice', 'bob'] })

    const { fresh } = applyLikeObservations(unliked, [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW + 2 })
    expect(fresh).toEqual([])
  })

  it('stops tracking a target past 200 likers', () => {
    const crowd = Array.from({ length: 199 }, (_, i) => `u${i}`)
    const { snapshot, fresh } = applyLikeObservations(baselined(), [observe('post', { P1: 201 }, { P1: crowd })], { selfId: ME, nowMs: NOW })

    expect(fresh).toEqual([])
    expect(snapshot.targets['post:P1']).toEqual({ count: 201, likers: null })
  })

  it('forgets batches older than a week', () => {
    const old = applyLikeObservations(baselined(), [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW }).snapshot

    expect(applyLikeObservations(old, [], { selfId: ME, nowMs: NOW + 6 * DAY }).snapshot.batches).toHaveLength(1)
    expect(applyLikeObservations(old, [], { selfId: ME, nowMs: NOW + 8 * DAY }).snapshot.batches).toEqual([])
  })
})

describe('stored snapshot', () => {
  it('round-trips through JSON', () => {
    const { snapshot } = applyLikeObservations(baselined(), [observe('post', { P1: 3 }, { P1: ['alice', 'bob', 'carol'] })], { selfId: ME, nowMs: NOW })

    expect(parseLikeSnapshot(JSON.stringify(snapshot))).toEqual(snapshot)
  })

  it.each([null, '', 'not json', '{"v":2}', '{"v":1,"baselined":"post","targets":{},"batches":[]}'])('reads %j as no snapshot (re-baseline)', (raw) => {
    expect(parseLikeSnapshot(raw)).toBeNull()
  })

  it('drops malformed entries', () => {
    const raw = JSON.stringify({
      v: 1,
      baselined: ['post', 'bogus'],
      targets: { 'post:P1': { count: 1, likers: ['a'] }, 'post:P2': { count: 'x' } },
      batches: [{ id: 'b', kind: 'post', targetId: 'P1', firstSeenMs: NOW, likers: [], total: 0 }],
    })

    expect(parseLikeSnapshot(raw)).toEqual({ v: 1, baselined: ['post'], horizons: {}, targets: { 'post:P1': { count: 1, likers: ['a'] } }, batches: [] })
  })
})
