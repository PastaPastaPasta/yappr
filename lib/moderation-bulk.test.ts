import { describe, expect, it, vi } from 'vitest'
import {
  HIDE_FEE_CREDITS,
  MAX_PENDING_WAITS,
  PACE_MS,
  SAME_REFUSAL_LIMIT,
  UNCONFIRMED_BACKOFF_MS,
  bulkCostLine,
  creditsToCents,
  formatCents,
  formatCredits,
  chainState,
  idsWithin,
  inLane,
  newestFirst,
  readEveryPage,
  runBulk,
  laneOf,
  oldestBlockTime,
  provedAt,
  freshReads,
  readPredatesRun,
  tabAfter,
  withRunChanges,
  type BulkApplyResult,
  type BulkChange,
  type BulkChainRead,
  type BulkChainState,
  type BulkItem,
  type BulkMode,
  type BulkPage,
  type BulkProgress,
  type BulkSeen,
} from './moderation-bulk'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const item = (id: string, hoursAgo: number, kind: BulkItem['kind'] = 'post'): BulkItem => ({ id, kind, createdAt: NOW - hoursAgo * HOUR, preview: `text ${id}` })

describe('selection', () => {
  const items = [item('a', 1), item('b', 23), item('c', 25), item('d', 24 * 6), item('e', 24 * 8)]

  it('selects by time range', () => {
    expect([...idsWithin(items, 'day', NOW)]).toEqual(['a', 'b'])
    expect([...idsWithin(items, 'week', NOW)]).toEqual(['a', 'b', 'c', 'd'])
    expect([...idsWithin(items, 'all', NOW)]).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('merges posts and replies newest first', () => {
    const posts = [item('p1', 1), item('p2', 5), item('p3', 9)]
    const replies = [item('r1', 2, 'reply'), item('r2', 5, 'reply'), item('r3', 20, 'reply')]
    expect(newestFirst(posts, replies).map((i) => i.id)).toEqual(['p1', 'r1', 'p2', 'r2', 'p3', 'r3'])
    expect(newestFirst([], replies).map((i) => i.id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('knows each lane', () => {
    expect(inLane({ live: 1 }, 'hide')).toBe(true)
    expect(inLane({ live: 1, mod: 1 }, 'hide')).toBe(false)
    expect(inLane({ live: 1, mod: 1 }, 'unhide')).toBe(true)
    // A legal hold is not this tool's to lift, and what was posted while restricted is out of the feeds already.
    expect(inLane({ live: 1, mod: 2 }, 'unhide')).toBe(false)
    expect(inLane({ live: 2 }, 'hide')).toBe(false)
    // A tombstone (no `live`) is no one's listing.
    expect(inLane({}, 'hide')).toBe(false)
  })

  it('reads where a document stands against a run', () => {
    expect(chainState({ live: 1 }, 'hide')).toBe('todo')
    expect(chainState({ live: 1, mod: 1 }, 'hide')).toBe('done')
    expect(chainState({ live: 1, mod: 2 }, 'hide')).toBe('done')
    expect(chainState(undefined, 'hide')).toBe('done')
    expect(chainState({ live: 1, mod: 1 }, 'unhide')).toBe('todo')
    expect(chainState({ live: 1 }, 'unhide')).toBe('done')
    // A legal hold is still hidden: an unhide never counts it done.
    expect(chainState({ live: 1, mod: 2 }, 'unhide')).toBe('changed')
    expect(chainState(undefined, 'unhide')).toBe('changed')
  })
})

describe('paging', () => {
  const pages = (all: BulkItem[], size: number) => vi.fn(async (startAfter?: string): Promise<BulkPage> => {
    const from = startAfter ? all.findIndex((i) => i.id === startAfter) + 1 : 0
    const items = all.slice(from, from + size)
    return { items, at: 1000 - from, ...(items.length === size ? { next: items[items.length - 1].id } : {}) }
  })

  it('reads every page until a short one', async () => {
    const all = Array.from({ length: 250 }, (_, n) => item(`i${n}`, n))
    const readPage = pages(all, 100)
    const seen: number[] = []
    const result = await readEveryPage(readPage, { onPage: (items) => seen.push(items.length) })
    expect(result.items).toHaveLength(250)
    expect(result.truncated).toBe(false)
    expect(readPage).toHaveBeenCalledTimes(3)
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'i99', 'i199'])
    expect(seen).toEqual([100, 200, 250])
    // As fresh as its oldest page.
    expect(result.at).toBe(800)
  })

  it('dates a read made of several answers by the oldest, and by none when one carries no block time', () => {
    expect(oldestBlockTime([30, 10, 20])).toBe(10)
    expect(oldestBlockTime([30, undefined])).toBeNaN()
    expect(oldestBlockTime([30, NaN])).toBeNaN()
  })

  it("dates each document by the answer that covered it, else the read's oldest", () => {
    const read = { todo: new Set<string>(), changed: new Set<string>(), at: 10, ats: new Map([['a', 30]]) }
    expect(provedAt(read, 'a')).toBe(30)
    expect(provedAt(read, 'b')).toBe(10)
  })

  it('reads one more page after a full last one, and stops at the cap', async () => {
    const all = Array.from({ length: 200 }, (_, n) => item(`i${n}`, n))
    expect((await readEveryPage(pages(all, 100))).items).toHaveLength(200)
    const capped = await readEveryPage(pages(all, 100), { max: 150 })
    expect(capped.items).toHaveLength(150)
    expect(capped.truncated).toBe(true)
  })

  it('never loops on a cursor that does not move, nor lists a document twice', async () => {
    const readPage = vi.fn(async (): Promise<BulkPage> => ({ items: [item('x', 1)], next: 'x' }))
    const result = await readEveryPage(readPage)
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(result.items.map((i) => i.id)).toEqual(['x'])
    // Stopped by the stall, not by a last page: the listing may go on.
    expect(result.truncated).toBe(true)
  })
})

describe('cost', () => {
  it('pairs credits with cents', () => {
    expect(creditsToCents(1_000_000)).toBeCloseTo(0.06)
    expect(formatCredits(99_400_000)).toBe('99M')
    expect(formatCredits(9_940_000)).toBe('9.9M')
    expect(formatCredits(1_250_000_000)).toBe('1.3B')
    expect(formatCents(6.24)).toBe('6.2¢')
    expect(formatCents(62.4)).toBe('62¢')
    expect(formatCents(624)).toBe('$6.24')
    expect(bulkCostLine(0, 100_000_000)).toBe('About 100M credits (6¢) each.')
    expect(bulkCostLine(10, 100_000_000)).toBe('About 1B credits (60¢), 100M credits (6¢) each.')
    expect(bulkCostLine(1)).toContain(formatCredits(HIDE_FEE_CREDITS))
    expect(bulkCostLine(1, 100_000_000)).toBe('About 100M credits (6¢).')
  })
})

describe("a run's changes over a lagging read", () => {
  const doc = (id: string, createdAt: number): BulkItem => ({ id, kind: 'post', createdAt, preview: id })
  const NOW = 1_000_000
  /** Run changes, each known as of a block time (default: just after the read at NOW). */
  const changes = (...entries: [BulkItem, BulkMode | null, number?][]) => new Map(entries.map(([item, tab, at = NOW + 1]) => [item.id, { item, tab, at }] as const))

  it('puts a document where the change leaves it: its own transition per the run, a read per its marks', () => {
    expect(tabAfter('hide', {})).toBe('unhide')
    expect(tabAfter('unhide', {})).toBe('hide')
    expect(tabAfter('hide', { marks: null })).toBe('hide')
    // What a chain read holds for a listed document: no mod, maybe who cleared it.
    expect(tabAfter('unhide', { marks: {} })).toBe('hide')
    expect(tabAfter('unhide', { marks: { moderatedBy: 'x', moderatedAt: 1 } as BulkChange['marks'] })).toBe('hide')
    expect(tabAfter('unhide', { marks: { mod: 1 } as BulkChange['marks'] })).toBe('unhide')
    expect(tabAfter('hide', { marks: { mod: 2 } as BulkChange['marks'] })).toBeNull()
    // A read that says where it lists the document wins over its marks (a tombstone keeps its mod).
    expect(tabAfter('unhide', { marks: { mod: 1 } as BulkChange['marks'], tab: null })).toBeNull()
    expect(tabAfter('hide', { marks: null, tab: 'unhide' })).toBe('unhide')
  })

  it('lists a document a read found in neither tab (a legal hold, a tombstone) in neither, whatever a lagging read shows', () => {
    const held = doc('h', 2)
    const other = doc('o', 1)
    const neither = changes([held, null])
    expect(withRunChanges([held, other], 'hide', neither, NOW).map((item) => item.id)).toEqual(['o'])
    expect(withRunChanges([held], 'unhide', neither, NOW)).toEqual([])
  })

  it('knows where a stored document is listed', () => {
    expect(laneOf({ live: 1 })).toBe('hide')
    expect(laneOf({ live: 1, mod: 1 })).toBe('unhide')
    expect(laneOf({ live: 1, mod: 2 })).toBeNull()
    expect(laneOf({ live: 0 })).toBeNull()
  })

  it('reads the lists again while a read was proved before a run change', () => {
    expect(readPredatesRun(new Map(), NOW)).toBe(false)
    expect(readPredatesRun(changes([doc('a', 1), 'hide', NOW]), NOW)).toBe(false)
    expect(readPredatesRun(changes([doc('a', 1), 'hide', NOW], [doc('b', 2), 'unhide', NOW + 20]), NOW)).toBe(true)
    // A read of unknown age may predate any of them.
    expect(readPredatesRun(changes([doc('a', 1), 'hide', NOW]), NaN)).toBe(true)
  })

  it("refuses a run's by-ID read older than the list it acts on, a run change, or a read it already accepted", () => {
    const at = (time: number, ats: [string, number][] = []): BulkChainRead => ({ todo: new Set(), changed: new Set(), at: time, ats: new Map(ats) })
    const a = doc('a', 1)
    const b = doc('b', 2)
    // The row came from a list proved at NOW: an older answer cannot settle it.
    const listed = freshReads(new Map(), NOW)
    expect(() => listed([a])(at(NOW - 20))).toThrow()
    expect(listed([a])(at(NOW))).toEqual(at(NOW))
    // ...nor one older than an answer this run already accepted for it.
    expect(() => listed([a])(at(NOW + 10, [['a', NOW + 5]]))).not.toThrow()
    expect(() => listed([a])(at(NOW + 1))).toThrow()
    // A run change to b at NOW + 20 is a floor for b only; each is judged by its own answer.
    const run = freshReads(changes([b, 'hide', NOW + 20]), -Infinity)
    expect(() => run([a, b])(at(NOW, [['b', NOW + 20]]))).not.toThrow()
    expect(() => run([b])(at(NOW + 19))).toThrow()
    // Nothing known of a document: even an answer of unknown age is taken.
    expect(() => freshReads(new Map(), -Infinity)([a])(at(NaN))).not.toThrow()
    // A change or list of unknown proof time sets no floor; the list's still does.
    expect(() => freshReads(changes([a, 'hide', NaN]), -Infinity)([a])(at(NOW))).not.toThrow()
    expect(() => freshReads(changes([a, 'hide', NaN]), NaN)([a])(at(NOW))).not.toThrow()
    expect(() => freshReads(changes([a, 'hide', NaN]), NOW)([a])(at(NOW - 1))).toThrow()
  })

  it('lets a read proved after the run show what changed since, however soon it came (an author\'s tombstone)', () => {
    const hidden = doc('h', 2)
    // This run hid h at NOW; its author deleted it a block later, and the Hidden read was proved after that.
    expect(withRunChanges([], 'unhide', changes([hidden, 'unhide', NOW]), NOW + 1)).toEqual([])
    // A node still a block behind the hide lists it as showing: the run's change wins there.
    expect(withRunChanges([hidden], 'hide', changes([hidden, 'unhide', NOW]), NOW - 1)).toEqual([])
  })

  it('never ranks a change of unknown block time above a read, and ranks every known one above a read of unknown age', () => {
    const x = doc('x', 1)
    const unknown = new Map([[x.id, { item: x, tab: 'unhide' as const }]])
    expect(withRunChanges([x], 'hide', unknown, NOW).map((item) => item.id)).toEqual(['x'])
    expect(withRunChanges([x], 'hide', changes([x, 'unhide', NOW]), undefined)).toEqual([])
  })

  it('lists what the run unhid under Showing and not under Hidden, whatever the read reached', () => {
    const a = doc('a', 3)
    const b = doc('b', 2)
    const c = doc('c', 1)
    const unhid = changes([a, 'hide'], [b, 'hide'])
    // One unhide landed a block after the other: this node shows only a, and still lists b as hidden.
    expect(withRunChanges([a, c], 'hide', unhid, NOW).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(withRunChanges([b], 'unhide', unhid, NOW)).toEqual([])
  })

  it('leaves a read alone when the run changed nothing in it, or when it was proved at or after its changes', () => {
    const read = [doc('x', 2), doc('y', 1)]
    expect(withRunChanges(read, 'unhide', new Map(), NOW)).toEqual(read)
    expect(withRunChanges(read, 'unhide', changes([doc('z', 3), 'hide']), NOW)).toEqual(read)
    // Another moderator unhid x after this run hid it: a read proved since wins.
    expect(withRunChanges([doc('x', 2)], 'hide', changes([doc('x', 2), 'unhide', NOW]), NOW).map((item) => item.id)).toEqual(['x'])
  })
})

describe('runBulk', () => {
  const ok: BulkApplyResult = { success: true }
  type Apply = (item: BulkItem, guard: () => Promise<boolean>) => Promise<BulkApplyResult>
  /** The ids a chain read finds still to do; `changed` ones changed some other way. */
  type Pending = (items: readonly BulkItem[]) => Promise<Set<string>>
  const deps = ({ apply, pending, changed = [], recheck, cancelled, onProgress }: {
    apply?: Apply
    pending?: Pending
    changed?: string[]
    recheck?: (item: BulkItem) => Promise<BulkChainState>
    cancelled?: () => boolean
    onProgress?: (progress: BulkProgress) => void
  } = {}) => {
    const todo: Pending = pending ?? (async (asked) => new Set(asked.map((i) => i.id)))
    return {
      apply: vi.fn<Apply>(apply ?? (async () => ok)),
      // Every document read is found; those neither to do nor changed read as listed (no marks).
      pending: vi.fn(async (asked: readonly BulkItem[]): Promise<BulkChainRead> => {
        const still = await todo(asked)
        const done = asked.filter((i) => !still.has(i.id) && !changed.includes(i.id))
        return { todo: still, changed: new Set(changed), marks: new Map(done.map((i) => [i.id, null])) }
      }),
      onDone: vi.fn<(item: BulkItem, change: BulkChange) => void>(),
      onSeen: vi.fn<(item: BulkItem, seen: BulkSeen) => void>(),
      pause: vi.fn<(ms: number) => Promise<void>>(async () => {}),
      // The one-document read just before signing, found as `recheck` says (done: listed, no marks).
      ...(recheck ? {
        recheck: vi.fn(async (i: BulkItem): Promise<BulkChainRead> => {
          const state = await recheck(i)
          return {
            todo: new Set(state === 'todo' ? [i.id] : []),
            changed: new Set(state === 'changed' ? [i.id] : []),
            marks: new Map(state === 'done' ? [[i.id, null]] : []),
            lanes: new Map<string, BulkMode | null>(state === 'done' ? [[i.id, 'unhide']] : state === 'changed' ? [[i.id, null]] : []),
          }
        }),
      } : {}),
      cancelled,
      onProgress,
    }
  }
  const items = [item('a', 1), item('b', 2), item('c', 3, 'reply')]

  it('sends one transition per document, newest first, paced', async () => {
    const d = deps()
    const summary = await runBulk(items, d)
    expect(d.apply.mock.calls.map(([i]) => i.id)).toEqual(['a', 'b', 'c'])
    expect(summary).toMatchObject({ total: 3, done: 3, failures: [], stopped: null, current: null })
    expect(d.pause.mock.calls.map(([ms]) => ms)).toEqual([PACE_MS, PACE_MS])
  })

  it('resumes from the chain: what is already done is counted, not sent again', async () => {
    const d = deps({ pending: vi.fn(async () => new Set(['c'])) })
    const summary = await runBulk(items, d)
    expect(d.apply.mock.calls.map(([i]) => i.id)).toEqual(['c'])
    expect(summary.done).toBe(3)
    // Every confirmed one reaches the cards on screen: a and b with what the read holds, c as this run asked.
    expect(d.onDone.mock.calls.map(([i, change]) => [i.id, change])).toEqual([['a', { marks: null }], ['b', { marks: null }], ['c', {}]])
  })

  it('settles, announces and sends nothing on a first read the guard refuses as older than the row', async () => {
    const d = deps()
    const guard = freshReads(new Map(), NOW)
    const stale = d.pending
    const pending = vi.fn(async (asked: readonly BulkItem[]) => guard(asked)({ ...(await stale(asked)), todo: new Set(), at: NOW - 1 }))
    const summary = await runBulk(items, { ...d, pending })
    expect(summary).toMatchObject({ done: 0, stopped: 'fatal' })
    expect(d.apply).not.toHaveBeenCalled()
    expect(d.onDone).not.toHaveBeenCalled()
  })

  it('counts a document the read no longer finds, without announcing it', async () => {
    const d = deps()
    d.pending.mockImplementationOnce(async () => ({ todo: new Set(), changed: new Set(), marks: new Map() }))
    const summary = await runBulk([items[0]], d)
    expect(summary.done).toBe(1)
    expect(d.onDone).not.toHaveBeenCalled()
  })

  it('never counts a document that changed some other way as done', async () => {
    const d = deps({ pending: async () => new Set(['c']), changed: ['b'] })
    const summary = await runBulk(items, d)
    expect(d.apply.mock.calls.map(([i]) => i.id)).toEqual(['c'])
    expect(summary.done).toBe(2)
    expect(summary.failures.map((f) => f.item.id)).toEqual(['b'])
    expect(d.onDone.mock.calls.map(([i]) => i.id)).not.toContain('b')
  })

  it('reads each document again just before its transition, and leaves what changed since', async () => {
    const states: Record<string, BulkChainState> = { a: 'todo', b: 'changed', c: 'done' }
    const d = deps({ recheck: async (i) => states[i.id] })
    const summary = await runBulk(items, d)
    // b was put under legal hold since the list was read: never sent, so the hold stands.
    expect(d.apply.mock.calls.map(([i]) => i.id)).toEqual(['a'])
    expect(summary.done).toBe(2)
    expect(summary.failures.map((f) => f.item.id)).toEqual(['b'])
    // c was done by someone else: counted, and announced with what that read holds, where it lists it.
    expect(d.onDone.mock.calls.map(([i, change]) => [i.id, change])).toEqual([['a', {}], ['c', { marks: null, tab: 'unhide' }]])
    // b is not done, but the read found it in neither tab: that is said apart from the count.
    expect(d.onSeen.mock.calls.map(([i, seen]) => [i.id, seen])).toEqual([['b', { tab: null }]])
  })

  it('says where the first read lists one that changed some other way, as of that read, without counting it', async () => {
    const d = deps()
    // The author deleted a hidden post before its unhide: it keeps its mod, but is listed nowhere.
    d.pending.mockImplementationOnce(async () => ({ todo: new Set(), changed: new Set(['a']), marks: new Map(), lanes: new Map([['a', null]]), at: 5 }))
    const summary = await runBulk([items[0]], d)
    expect(summary.done).toBe(0)
    expect(summary.failures).toMatchObject([{ item: { id: 'a' }, retryable: false }])
    expect(d.onDone).not.toHaveBeenCalled()
    expect(d.onSeen).toHaveBeenCalledWith(items[0], { tab: null, seenAt: 5 })
  })

  it('dates what a read settled by the block time it was proved at', async () => {
    const d = deps()
    d.pending.mockImplementationOnce(async () => ({ todo: new Set(), changed: new Set(), marks: new Map([['a', null]]), lanes: new Map([['a', 'hide']]), at: 7 }))
    await runBulk([items[0]], d)
    expect(d.onDone).toHaveBeenCalledWith(items[0], { marks: null, tab: 'hide', seenAt: 7 })
  })

  it('sends nothing for a document it cannot read again, and stops after three in a row', async () => {
    const many = Array.from({ length: 5 }, (_, n) => item(`m${n}`, n))
    const d = deps({ recheck: async () => { throw new Error('offline') } })
    const summary = await runBulk(many, d)
    expect(d.apply).not.toHaveBeenCalled()
    expect(summary.failures).toHaveLength(SAME_REFUSAL_LIMIT)
    expect(summary.stopped).toBe('fatal')
  })

  it('announces a document the first read found under a legal hold with the tab that read lists it in: neither', async () => {
    const d = deps()
    const held = { mod: 2 } as NonNullable<BulkChange['marks']>
    d.pending.mockImplementationOnce(async () => ({ todo: new Set(), changed: new Set(), marks: new Map([['a', held]]), lanes: new Map([['a', null]]) }))
    await runBulk([items[0]], d)
    expect(d.onDone.mock.calls[0][1]).toEqual({ marks: held, tab: null })
    expect(tabAfter('hide', d.onDone.mock.calls[0][1])).toBeNull()
  })

  it('counts an unconfirmed change the chain shows landed, announcing what the read holds', async () => {
    let reads = 0
    const d = deps({
      apply: async () => ({ success: false, errorCode: 'MAYBE_APPLIED' }),
      pending: async (asked) => new Set(reads++ === 0 ? asked.map((i) => i.id) : []),
    })
    const summary = await runBulk([items[0]], d)
    expect(summary.done).toBe(1)
    // Never as this run's own change: the read may hold another moderator's (a legal hold).
    expect(d.onDone.mock.calls[0][1]).toEqual({ marks: null })
  })

  it('stops before signing when Stop is pressed while the document is read again', async () => {
    let stop = false
    const d = deps({
      recheck: async () => {
        stop = true
        return 'todo'
      },
      cancelled: () => stop,
    })
    const summary = await runBulk(items, d)
    expect(d.apply).not.toHaveBeenCalled()
    expect(summary.stopped).toBe('cancelled')
  })

  it('asks again under the write lock, and leaves a document held since', async () => {
    let calls = 0
    // Still to do when read before its turn; under a legal hold by the time the lock is held.
    const recheck = async (): Promise<BulkChainState> => (calls++ % 2 === 0 ? 'todo' : 'changed')
    const d = deps({
      recheck,
      apply: async (_item, guard) => ((await guard()) ? ok : { success: false, errorCode: 'PRECONDITION_FAILED' }),
    })
    const summary = await runBulk([items[0]], d)
    expect(summary.done).toBe(0)
    expect(summary.failures).toEqual([{ item: items[0], error: expect.stringContaining('changed'), retryable: false }])
  })

  it('sends nothing when the first read fails', async () => {
    const d = deps({ pending: vi.fn(async () => { throw new Error('offline') }) })
    const summary = await runBulk(items, d)
    expect(d.apply).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ done: 0, stopped: 'fatal', failures: [] })
  })

  it('counts "already that way" as done', async () => {
    const d = deps({ apply: vi.fn(async (i: BulkItem): Promise<BulkApplyResult> => (i.id === 'a' ? { success: false, errorCode: 'NOTHING_TO_CHANGE' } : ok)) })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(3)
    expect(summary.done).toBe(3)
    // Already that way by no change of this run's: nothing is said of its marks or when.
    expect(d.onDone.mock.calls.map(([i]) => i.id)).toEqual(['b', 'c'])
  })

  it('reports progress, counting only confirmed changes', async () => {
    const seen: BulkProgress[] = []
    await runBulk(items, deps({ onProgress: (p) => seen.push(p) }))
    expect(seen[0]).toMatchObject({ done: 0, current: null })
    expect(seen.find((p) => p.current?.id === 'b')).toMatchObject({ done: 1 })
    expect(seen[seen.length - 1]).toMatchObject({ done: 3, current: null })
  })

  it('lists a failure and goes on', async () => {
    const d = deps({ apply: vi.fn(async (i: BulkItem): Promise<BulkApplyResult> => (i.id === 'b' ? { success: false, error: 'Refused', errorCode: 'DOCUMENT_GONE' } : ok)) })
    const summary = await runBulk(items, d)
    expect(summary.done).toBe(2)
    expect(summary.failures).toEqual([{ item: items[1], error: 'Refused', retryable: true }])
    expect(summary.stopped).toBeNull()
  })

  it('settles an unconfirmed answer by reading the chain again', async () => {
    const apply = vi.fn(async (i: BulkItem): Promise<BulkApplyResult> => (i.id === 'a' || i.id === 'b' ? { success: false, errorCode: 'MAYBE_APPLIED' } : ok))
    // a landed, b did not.
    const pending = vi.fn(async (asked: readonly BulkItem[]) => new Set(asked.length === 3 ? ['a', 'b', 'c'] : ['b']))
    const d = deps({ apply, pending })
    const summary = await runBulk(items, d)
    expect(pending).toHaveBeenCalledTimes(2)
    expect(pending.mock.calls[1][0].map((i) => i.id)).toEqual(['a', 'b'])
    expect(summary.done).toBe(2)
    expect(summary.failures.map((f) => f.item.id)).toEqual(['b'])
    expect(d.pause.mock.calls.map(([ms]) => ms)).toContain(UNCONFIRMED_BACKOFF_MS)
  })

  it('treats a thrown apply as unconfirmed', async () => {
    let reads = 0
    const d = deps({
      apply: vi.fn(async () => { throw new Error('socket hang up') }),
      // Pending at the start; all landed by the second read.
      pending: vi.fn(async (asked: readonly BulkItem[]) => new Set(reads++ === 0 ? asked.map((i) => i.id) : [])),
    })
    const summary = await runBulk(items, d)
    expect(summary.done).toBe(3)
    expect(summary.failures).toEqual([])
  })

  it('stops after the transition under way when cancelled', async () => {
    let stop = false
    const d = deps({
      apply: vi.fn(async (): Promise<BulkApplyResult> => {
        stop = true
        return ok
      }),
      cancelled: () => stop,
    })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ done: 1, stopped: 'cancelled' })
  })

  it('sends nothing more once stopped during the wait between two transitions', async () => {
    let stop = false
    const d = deps({ cancelled: () => stop })
    d.pause.mockImplementation(async () => {
      stop = true
    })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ done: 1, stopped: 'cancelled' })
  })

  it('stops on the same refusal three times in a row, but never on gateway timeouts', async () => {
    const many = Array.from({ length: 6 }, (_, n) => item(`m${n}`, n))
    const refused = deps({ apply: async () => ({ success: false, error: 'Odd refusal', errorCode: 'DOCUMENT_GONE' }) })
    const summary = await runBulk(many, refused)
    expect(refused.apply).toHaveBeenCalledTimes(SAME_REFUSAL_LIMIT)
    expect(summary).toMatchObject({ stopped: 'fatal', error: 'Odd refusal' })
    expect(summary.failures).toHaveLength(SAME_REFUSAL_LIMIT)

    let reads = 0
    const timeouts = deps({
      apply: async () => ({ success: false, errorCode: 'MAYBE_APPLIED' }),
      pending: async (asked) => new Set(reads++ === 0 ? asked.map((i) => i.id) : []),
    })
    const settled = await runBulk(many, timeouts)
    expect(timeouts.apply).toHaveBeenCalledTimes(6)
    expect(settled).toMatchObject({ stopped: null, done: 6 })
  })

  it('sends a document again while an earlier change is still going through', async () => {
    let calls = 0
    const d = deps({ apply: async (i) => (i.id === 'b' && calls++ < 2 ? { success: false, errorCode: 'WRITE_PENDING' } : ok) })
    const summary = await runBulk(items, d)
    expect(d.apply.mock.calls.map(([i]) => i.id)).toEqual(['a', 'b', 'b', 'b', 'c'])
    expect(summary).toMatchObject({ done: 3, failures: [] })
    expect(d.pause.mock.calls.map(([ms]) => ms)).toContain(UNCONFIRMED_BACKOFF_MS)
  })

  it('gives up on a document held back too long, and settles it from the chain', async () => {
    // Every read says it is still to do: it never went out.
    const d = deps({ apply: async () => ({ success: false, errorCode: 'WRITE_PENDING' }) })
    const summary = await runBulk([items[0]], d)
    expect(d.apply).toHaveBeenCalledTimes(MAX_PENDING_WAITS)
    expect(summary.failures.map((f) => f.item.id)).toEqual(['a'])
  })

  it('stops at once on an answer every other document would get too', async () => {
    const d = deps({ apply: vi.fn(async (): Promise<BulkApplyResult> => ({ success: false, error: 'Needs your key', errorCode: 'NEEDS_CRITICAL_KEY' })) })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ done: 0, stopped: 'fatal', error: 'Needs your key', failures: [] })
  })

  it('stops at the first refusal for want of credits', async () => {
    const d = deps({ apply: async () => ({ success: false, error: 'Top it up', errorCode: 'INSUFFICIENT_CREDITS' }) })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ stopped: 'fatal', error: 'Top it up', failures: [] })
  })

  it('stops quietly when the key sheet is closed', async () => {
    const d = deps({ apply: vi.fn(async (): Promise<BulkApplyResult> => ({ success: false, errorCode: 'CANCELLED' })) })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary.stopped).toBe('cancelled')
    expect(summary.error).toBeUndefined()
  })
})
