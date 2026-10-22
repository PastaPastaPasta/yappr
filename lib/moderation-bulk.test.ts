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
  idsWithin,
  inLane,
  newestFirst,
  readEveryPage,
  runBulk,
  type BulkApplyResult,
  type BulkItem,
  type BulkPage,
  type BulkProgress,
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
})

describe('paging', () => {
  const pages = (all: BulkItem[], size: number) => vi.fn(async (startAfter?: string): Promise<BulkPage> => {
    const from = startAfter ? all.findIndex((i) => i.id === startAfter) + 1 : 0
    const items = all.slice(from, from + size)
    return { items, ...(items.length === size ? { next: items[items.length - 1].id } : {}) }
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
  })
})

describe('runBulk', () => {
  const ok: BulkApplyResult = { success: true }
  type Apply = (item: BulkItem) => Promise<BulkApplyResult>
  type Pending = (items: readonly BulkItem[]) => Promise<Set<string>>
  const deps = ({ apply, pending, cancelled, onProgress }: {
    apply?: Apply
    pending?: Pending
    cancelled?: () => boolean
    onProgress?: (progress: BulkProgress) => void
  } = {}) => ({
    apply: vi.fn<Apply>(apply ?? (async () => ok)),
    pending: vi.fn<Pending>(pending ?? (async (asked) => new Set(asked.map((i) => i.id)))),
    pause: vi.fn<(ms: number) => Promise<void>>(async () => {}),
    cancelled,
    onProgress,
  })
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
  })

  it('sends everything when the first read fails, and counts "already that way" as done', async () => {
    const d = deps({
      pending: vi.fn(async () => { throw new Error('offline') }),
      apply: vi.fn(async (i: BulkItem): Promise<BulkApplyResult> => (i.id === 'a' ? { success: false, errorCode: 'NOTHING_TO_CHANGE' } : ok)),
    })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(3)
    expect(summary.done).toBe(3)
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
    expect(summary.failures).toEqual([{ item: items[1], error: 'Refused' }])
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

  it('stops quietly when the key sheet is closed', async () => {
    const d = deps({ apply: vi.fn(async (): Promise<BulkApplyResult> => ({ success: false, errorCode: 'CANCELLED' })) })
    const summary = await runBulk(items, d)
    expect(d.apply).toHaveBeenCalledTimes(1)
    expect(summary.stopped).toBe('cancelled')
    expect(summary.error).toBeUndefined()
  })
})
