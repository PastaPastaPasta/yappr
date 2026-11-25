import { describe, expect, it, vi } from 'vitest'
import type { KindedTarget } from '@/lib/contract-topology'
import { bumpSessionGeneration, sessionGeneration } from '@/lib/auth/session-generation'
import { createMarksLoader, createSlotLock, createSlotWrites, fillMark, knowsMark, marksFor, noMarksRead, postMarks, withMark, type Marks, type MarksReader } from './viewer-marks'

const unmarked: Marks = { liked: false, reposted: false, bookmarked: false }

/** A loader whose batches run when `flush` is called, with the reader's calls recorded. */
function harness(answer: (targets: readonly KindedTarget[], viewerId: string) => Map<string, Marks> | Promise<Map<string, Marks>>) {
  let pending: (() => void) | null = null
  const reader = vi.fn<MarksReader>(async (targets, viewerId) => answer(targets, viewerId))
  const load = createMarksLoader(reader, (flush) => { pending = flush })
  const flush = () => {
    const run = pending
    pending = null
    run?.()
  }
  return { load, reader, flush }
}

describe('postMarks', () => {
  it('trusts a post\'s marks only when a read for a viewer set them', () => {
    expect(postMarks({ liked: true, reposted: false, bookmarked: false })).toBeUndefined()
    expect(postMarks({ liked: true, marksFor: 'alice' })).toBeUndefined()
    expect(postMarks({ liked: true, marksFor: 'alice', marksSession: 3, ownQuote: { id: 'q', bare: true } }))
      .toEqual({ viewerId: 'alice', session: 3, liked: true, reposted: false, bookmarked: false, ownQuote: { id: 'q', bare: true } })
  })
})

describe('marksFor', () => {
  const aliceNow = () => ({ viewerId: 'alice', session: sessionGeneration(), ...unmarked, liked: true })

  it('keeps marks read for this viewer in this session', () => {
    const alice = aliceNow()
    expect(marksFor(alice, 'alice')).toBe(alice)
  })

  it('drops marks read before the session changed, even for the same account', () => {
    const alice = aliceNow()
    bumpSessionGeneration()
    bumpSessionGeneration()
    expect(marksFor(alice, 'alice')).toBeUndefined()
  })

  it('drops marks read for another viewer, or when signed out', () => {
    const alice = aliceNow()
    expect(marksFor(alice, 'bob')).toBeUndefined()
    expect(marksFor(alice, undefined)).toBeUndefined()
    expect(marksFor(undefined, 'alice')).toBeUndefined()
  })
})

describe('createMarksLoader', () => {
  it('reads the cards of one task together, one batch per viewer', async () => {
    const { load, reader, flush } = harness((targets) => new Map(targets.map((t) => [t.id, { ...unmarked, liked: t.id === 'p1' }])))
    const reads = [
      load('alice', { id: 'p1', kind: 'post' }),
      load('alice', { id: 'r1', kind: 'reply' }),
      load('bob', { id: 'p1', kind: 'post' }),
    ]
    flush()
    const [p1, r1, bobP1] = await Promise.all(reads)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(reader).toHaveBeenCalledWith([{ id: 'p1', kind: 'post' }, { id: 'r1', kind: 'reply' }], 'alice')
    expect(reader).toHaveBeenCalledWith([{ id: 'p1', kind: 'post' }], 'bob')
    expect(p1).toEqual({ viewerId: 'alice', session: sessionGeneration(), ...unmarked, liked: true })
    expect(r1).toEqual({ viewerId: 'alice', session: sessionGeneration(), ...unmarked })
    expect(bobP1.viewerId).toBe('bob')
  })

  it('joins a read already under way for the same viewer and target', async () => {
    const { load, reader, flush } = harness((targets) => new Map(targets.map((t) => [t.id, unmarked])))
    const first = load('alice', { id: 'p1', kind: 'post' })
    expect(load('alice', { id: 'p1', kind: 'post' })).toBe(first)
    flush()
    await first
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('does not join a read started in an earlier session', async () => {
    const { load, reader, flush } = harness((targets) => new Map(targets.map((t) => [t.id, unmarked])))
    const first = load('alice', { id: 'p1', kind: 'post' })
    bumpSessionGeneration()
    const second = load('alice', { id: 'p1', kind: 'post' })
    expect(second).not.toBe(first)
    flush()
    const [a, b] = await Promise.all([first, second])
    expect(b.session).toBe(a.session + 1)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing once a read settles: the next request reads again', async () => {
    const { load, reader, flush } = harness((targets) => new Map(targets.map((t) => [t.id, unmarked])))
    const first = load('alice', { id: 'p1', kind: 'post' })
    flush()
    await first
    const second = load('alice', { id: 'p1', kind: 'post' })
    expect(second).not.toBe(first)
    flush()
    await second
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('rejects a target the read did not answer, so its marks stay unknown', async () => {
    const { load, flush } = harness(() => new Map([['p1', unmarked]]))
    const answered = load('alice', { id: 'p1', kind: 'post' })
    const unanswered = load('alice', { id: 'p2', kind: 'post' })
    flush()
    await expect(answered).resolves.toMatchObject({ viewerId: 'alice' })
    await expect(unanswered).rejects.toThrow('No marks were read')
  })

  it('rejects every card of a failed read, and the next request tries again', async () => {
    let fail = true
    const { load, flush } = harness((targets) => {
      if (fail) throw new Error('quorum')
      return new Map(targets.map((t) => [t.id, unmarked]))
    })
    const failed = load('alice', { id: 'p1', kind: 'post' })
    flush()
    await expect(failed).rejects.toThrow('quorum')
    fail = false
    const retried = load('alice', { id: 'p1', kind: 'post' })
    flush()
    await expect(retried).resolves.toMatchObject({ viewerId: 'alice', liked: false })
  })
})

describe('marks read one at a time', () => {
  it('knows only the marks a read set, so an unread one never decides a write', () => {
    const liked = withMark(noMarksRead('alice', 1), 'liked', { liked: true })
    expect(liked).toEqual({ viewerId: 'alice', session: 1, liked: true, reposted: false, bookmarked: false, unread: ['reposted', 'bookmarked'] })
    expect(knowsMark(liked, 'liked')).toBe(true)
    expect(knowsMark(liked, 'bookmarked')).toBe(false)
    expect(knowsMark(null, 'liked')).toBe(false)
  })

  it('keeps a mark a newer read or write set when an older read lands after it', () => {
    const unknown = noMarksRead('alice', 1)
    // Repost's read and write land first and take the slot; Quote's earlier empty read lands late.
    const reposted = withMark(unknown, 'reposted', { reposted: true, ownQuote: { id: 'r', bare: true } })
    expect(fillMark(reposted, 'reposted', { reposted: false })).toBe(reposted)
    expect(fillMark(unknown, 'reposted', { reposted: false }).reposted).toBe(false)
    expect(knowsMark(fillMark(unknown, 'reposted', { reposted: false }), 'reposted')).toBe(true)
  })

  it('becomes fully known once every mark is read, with the repost\'s quote', () => {
    let marks = withMark(noMarksRead('alice', 1), 'liked', { liked: false })
    marks = withMark(marks, 'reposted', { reposted: true, ownQuote: { id: 'q', bare: false } })
    marks = withMark(marks, 'bookmarked', { bookmarked: true })
    expect(marks).toEqual({ viewerId: 'alice', session: 1, liked: false, reposted: true, bookmarked: true, ownQuote: { id: 'q', bare: false } })
    expect(withMark(marks, 'reposted', { reposted: false }).ownQuote).toBeUndefined()
  })
})

describe('createSlotLock', () => {
  it('lets one action hold a key until it settles, across callers', async () => {
    const slots = createSlotLock()
    let release = () => {}
    const quote = slots.hold('alice|p1', () => new Promise<string>((resolve) => { release = () => resolve('quote') }))
    // Another card's Repost on the same post is ignored meanwhile; another post is free.
    expect(await slots.hold('alice|p1', async () => 'repost')).toBeNull()
    expect(await slots.hold('alice|p2', async () => 'repost')).toBe('repost')
    release()
    expect(await quote).toBe('quote')
    expect(await slots.hold('alice|p1', async () => 'repost')).toBe('repost')
  })

  it('frees the key when the action fails', async () => {
    const slots = createSlotLock()
    await expect(slots.hold('k', async () => { throw new Error('read failed') })).rejects.toThrow('read failed')
    expect(await slots.hold('k', async () => 'ok')).toBe('ok')
  })
})

describe('createSlotWrites', () => {
  const repost = { id: 'r', bare: true }
  const free = { reposted: false }
  const setup = () => {
    const clock = { session: 1, now: 0 }
    return { clock, writes: createSlotWrites(() => clock.session, () => clock.now, 60_000) }
  }

  it('shows a repost made on one card to another card whose read does not show it yet', () => {
    const { writes } = setup()
    expect(writes.apply('alice', 'p1', free)).toBe(free)
    // Top reposts and its write finishes before Latest's Quote is tapped.
    writes.held('alice', 'p1', repost)
    const latest = withMark(noMarksRead('alice', 1), 'reposted', writes.apply('alice', 'p1', free))
    expect(latest.reposted).toBe(true)
    expect(latest.ownQuote).toEqual(repost)
    expect(writes.apply('alice', 'p2', free)).toBe(free)
    expect(writes.apply('bob', 'p1', free)).toBe(free)
  })

  it('gives way to the chain once a read catches up, the lag window passes, or the session changes', () => {
    const { clock, writes } = setup()
    writes.held('alice', 'p1', repost)
    const caughtUp = { reposted: true, ownQuote: repost }
    expect(writes.apply('alice', 'p1', caughtUp)).toBe(caughtUp)
    // Caught up once: a later free read (undone on another device) is trusted.
    expect(writes.apply('alice', 'p1', free)).toBe(free)

    writes.held('alice', 'p1', repost)
    clock.now = 60_000
    expect(writes.apply('alice', 'p1', free)).toBe(free)

    writes.held('alice', 'p1', repost)
    clock.session = 2
    expect(writes.apply('alice', 'p1', free)).toBe(free)
  })

  it('keeps a newer repost over a lagging read that still shows an earlier, removed one', () => {
    const { writes } = setup()
    writes.held('alice', 'p1', { id: 'r2', bare: true })
    expect(writes.apply('alice', 'p1', { reposted: true, ownQuote: repost })).toEqual({ reposted: true, ownQuote: { id: 'r2', bare: true } })
  })

  it('frees the slot only while a read still shows the removed repost, never hiding a newer quote', () => {
    const { writes } = setup()
    writes.freed('alice', 'p1', repost)
    expect(writes.apply('alice', 'p1', { reposted: true, ownQuote: repost })).toEqual({ reposted: false })
    // A quote written in the composer afterwards holds the slot: the read wins.
    const quoted = { reposted: true, ownQuote: { id: 'q', bare: false } }
    expect(writes.apply('alice', 'p1', quoted)).toBe(quoted)
    expect(writes.apply('alice', 'p1', { reposted: true, ownQuote: repost })).toEqual({ reposted: true, ownQuote: repost })
  })
})
