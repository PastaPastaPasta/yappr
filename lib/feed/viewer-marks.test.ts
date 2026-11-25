import { describe, expect, it, vi } from 'vitest'
import type { KindedTarget } from '@/lib/contract-topology'
import { bumpSessionGeneration, sessionGeneration } from '@/lib/auth/session-generation'
import { createMarksLoader, marksFor, postMarks, type Marks, type MarksReader } from './viewer-marks'

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
