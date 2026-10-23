import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `query` answers a window page as a document array; the SDK mock wraps it the
 * way `documents.queryWithProof` answers, with the block time `chainTime.ms`.
 */
const { query, chainTime } = vi.hoisted(() => ({ query: vi.fn(), chainTime: { ms: 0 } }))
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({
    documents: {
      queryWithProof: async (q: unknown) => {
        const docs = (await query(q)) as Array<{ $id: string }>
        return { data: new Map(docs.map((doc) => [doc.$id, doc])), metadata: { timeMs: chainTime.ms } }
      },
    },
  }),
}))

const GRID = { range: 302_400, step: 302_400 }
const STEP_MS = 302_400_000
// 1.25 windows into window k: the previous window starts at (k - 1) steps.
const K = 5_920
const NOW = K * STEP_MS + STEP_MS / 4

beforeEach(() => {
  vi.resetModules()
  query.mockReset()
  chainTime.ms = NOW
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function load() {
  const topology = await import('../contract-topology')
  const windows = await import('./notification-windows')
  const window = topology.notificationWindowFor('reply')
  if (!window) throw new Error('v10 has a reply window')
  return { ...windows, window }
}

type Query = { timeRange: [{ selector: 'newest' | 'byStart'; startMs?: number }]; startAfter?: string; limit: number }
const selectorOf = (q: Query) => q.timeRange[0].selector
type Which = 'newest' | 'byStart'

const page = (from: number, length: number, createdAt = (i: number) => 1_000 + i) =>
  Array.from({ length }, (_, i) => ({ $id: `doc-${from + i}`, $createdAt: createdAt(from + i) }))

/** Answers each window from its own pages, in call order per window. */
function windows(pages: Record<Which, Record<string, unknown>[][]>) {
  const served = { newest: 0, byStart: 0 }
  query.mockImplementation(async (q: Query) => {
    const selector = selectorOf(q)
    return pages[selector][served[selector]++] ?? []
  })
}

describe('notification window reads', () => {
  it('pins the recipient and names one window on the contract grid, with no time clause or orderBy', async () => {
    const { notificationWindowQuery, window } = await load()
    expect(notificationWindowQuery(window, { selector: 'newest' }, 'me')).toEqual({
      dataContractId: expect.any(String),
      documentTypeName: 'reply',
      where: [['parentOwnerId', '==', 'me']],
      timeRange: [{ field: '$createdAt', selector: 'newest', grid: GRID }],
      limit: 100,
    })
    expect(notificationWindowQuery(window, { selector: 'byStart', startMs: 7 }, 'me', 'doc-99')).toMatchObject({
      timeRange: [{ field: '$createdAt', selector: 'byStart', startMs: 7, grid: GRID }],
      startAfter: 'doc-99',
    })
  })

  it('names the previous window by its start on the grid (the node\'s `oldest` is the current one on this grid)', async () => {
    const { previousWindowStart } = await load()
    expect(previousWindowStart(GRID, NOW)).toBe((K - 1) * STEP_MS)
    expect(previousWindowStart(GRID, K * STEP_MS)).toBe((K - 1) * STEP_MS)
    expect(previousWindowStart(GRID, (K + 1) * STEP_MS - 1)).toBe((K - 1) * STEP_MS)
  })

  it('reads the current window and the previous one, one query each, and merges them newest first', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 2)], byStart: [page(10, 3)] })
    const { documents, watermarkLimit, passes } = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(query).toHaveBeenCalledTimes(2)
    const byStart = query.mock.calls.map(([q]) => q as Query).find((q) => selectorOf(q) === 'byStart')
    expect(byStart?.timeRange[0].startMs).toBe((K - 1) * STEP_MS)
    // Newest first by time, whatever the id order.
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-12', 'doc-11', 'doc-10', 'doc-1', 'doc-0'])
    // Both windows read whole: the watermark may move up to the block time they were read at.
    expect(watermarkLimit).toBe(NOW)
    expect(passes).toEqual([])
  })

  it('limits the watermark to the earliest block time any page was read at (a node a block behind)', async () => {
    const { readNotificationWindow, window } = await load()
    const times = [NOW, NOW - 5_000]
    windows({ newest: [page(0, 2)], byStart: [page(10, 3)] })
    const answer = query.getMockImplementation()
    query.mockImplementation(async (q: Query) => {
      chainTime.ms = times.shift() ?? NOW
      return answer?.(q)
    })
    expect((await readNotificationWindow(window, 'me', 0, [], NOW)).watermarkLimit).toBe(NOW - 5_000)
  })

  it('counts a previous window the node refuses as expired (clock ahead at a boundary) as empty, and fails on anything else', async () => {
    const { readNotificationWindow, window } = await load()
    query.mockImplementation(async (q: Query) => {
      if (selectorOf(q) === 'byStart') throw new Error('query for an expired time-range window')
      return page(0, 2)
    })
    expect(await readNotificationWindow(window, 'me', 0, [], NOW)).toEqual({
      documents: [expect.objectContaining({ $id: 'doc-1' }), expect.objectContaining({ $id: 'doc-0' })],
      watermarkLimit: NOW,
      passes: [],
    })
    query.mockImplementation(async (q: Query) => {
      if (selectorOf(q) === 'byStart') throw new Error('DAPI unavailable')
      return page(0, 2)
    })
    await expect(readNotificationWindow(window, 'me', 0, [], NOW)).rejects.toThrow('DAPI unavailable')
  })

  it('dedupes by id', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 3)], byStart: [page(0, 3)] })
    const { documents } = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-2', 'doc-1', 'doc-0'])
  })

  it('filters strictly after `since` client-side, in both windows', async () => {
    const { readNotificationWindow, window } = await load()
    windows({
      newest: [page(0, 3, (i) => [500, 1_500, 1_000][i])],
      byStart: [page(3, 2, (i) => [2_000, 999][i - 3])],
    })
    const { documents } = await readNotificationWindow(window, 'me', 1_000, [], NOW)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-3', 'doc-1'])
  })
})

describe('notification window reads past one poll\'s page budget', () => {
  const CURRENT = K * STEP_MS
  const PREVIOUS = (K - 1) * STEP_MS
  type Doc = { $id: string; $createdAt: number }
  const id = (n: number) => `doc-${String(n).padStart(5, '0')}`

  /**
   * A node holding `byWindow` (window start → documents): `newest` is the
   * window starting at `newestStart`, pages follow document id order and
   * continue after `startAfter`, as the index serves them.
   */
  function node(byWindow: Record<number, Doc[]>, newestStart = CURRENT) {
    const serve = async (q: Query) => {
      const pick = q.timeRange[0]
      const start = pick.selector === 'newest' ? newestStart : pick.startMs
      const docs = [...(start === undefined ? [] : byWindow[start] ?? [])].sort((a, b) => a.$id.localeCompare(b.$id))
      const from = q.startAfter ? docs.findIndex((doc) => doc.$id === q.startAfter) + 1 : 0
      return docs.slice(from, from + q.limit)
    }
    query.mockImplementation(serve)
    return serve
  }

  /** `count` documents of the current window; ids and times are unrelated, as on chain. */
  const busyWindow = (count: number, time = (n: number) => CURRENT + ((n * 7_919) % 100_000)) =>
    Array.from({ length: count }, (_, n) => ({ $id: id(n), $createdAt: time(n) }))

  const reads = (selector: Which) => query.mock.calls.map(([q]) => q as Query).filter((q) => selectorOf(q) === selector)

  it('reads ten pages a poll, holds the watermark at `since` meanwhile, and continues from the cursor it returned', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [CURRENT]: busyWindow(2_350) })

    const first = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(first.documents).toHaveLength(1_000)
    expect(first.watermarkLimit).toBe(0)
    expect(first.passes).toHaveLength(1)
    expect(reads('newest')).toHaveLength(10)

    query.mockClear()
    chainTime.ms = NOW + 30_000
    const second = await readNotificationWindow(window, 'me', 0, first.passes, NOW)
    expect(second.documents).toHaveLength(1_000)
    expect(second.watermarkLimit).toBe(0)
    // The continuation names the window it started on by its start, after the last id read.
    const continued = reads('byStart').filter((q) => q.timeRange[0].startMs === CURRENT)
    expect(continued).toHaveLength(10)
    expect(continued[0].startAfter).toBe(id(999))
    expect(reads('newest')).toHaveLength(0)

    query.mockClear()
    chainTime.ms = NOW + 60_000
    const third = await readNotificationWindow(window, 'me', 0, second.passes, NOW)
    expect(third.documents).toHaveLength(350)
    expect(third.passes).toEqual([])
    // Every document of the window came back once across the three polls.
    const all = [...first.documents, ...second.documents, ...third.documents].map((doc) => doc.$id)
    expect(new Set(all).size).toBe(2_350)
    // Done: no further than the block time of the pass's first pages, before
    // which every row it could have missed was already on chain.
    expect(third.watermarkLimit).toBe(NOW)
  })

  it('moves the watermark on with every pass (a busy window never pins it)', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [CURRENT]: Array.from({ length: 1_500 }, (_, n) => ({ $id: id(n), $createdAt: CURRENT + n })) })
    const limits: number[] = []
    let since = 0
    let cursor: Awaited<ReturnType<typeof readNotificationWindow>>['passes'] = []
    for (let poll = 0; poll < 6; poll++) {
      chainTime.ms = NOW + poll * 30_000
      const read = await readNotificationWindow(window, 'me', since, cursor, NOW)
      limits.push(read.watermarkLimit)
      if (Number.isFinite(read.watermarkLimit)) since = Math.max(since, read.watermarkLimit)
      cursor = read.passes
    }
    // Two polls a pass: held, then the block time the pass began at.
    expect(limits).toEqual([0, NOW, NOW, NOW + 60_000, NOW + 60_000, NOW + 120_000])
  })

  it('returns every row in the end, the newest by time included, where the old cap kept the first 1,000 ids', async () => {
    const { readNotificationWindow, window } = await load()
    // The newest reply has the highest id: past the first 1,000 ids.
    node({ [CURRENT]: busyWindow(1_200, (n) => (n === 1_199 ? CURRENT + 200_000 : CURRENT + n)) })

    const first = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(first.documents.map((doc) => doc.$id)).not.toContain(id(1_199))
    const second = await readNotificationWindow(window, 'me', 0, first.passes, NOW)
    expect(second.documents[0]).toEqual({ $id: id(1_199), $createdAt: CURRENT + 200_000 })
  })

  it('starts over without its cursor: a thrown-away result repeats its pages instead of skipping them', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [CURRENT]: busyWindow(1_500) })
    await readNotificationWindow(window, 'me', 0, [], NOW)
    query.mockClear()
    const again = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(reads('newest')[0].startAfter).toBeUndefined()
    expect(again.watermarkLimit).toBe(0)
  })

  it('ignores a pass for another `since` or another recipient', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [CURRENT]: busyWindow(1_500) })
    const { passes } = await readNotificationWindow(window, 'me', 0, [], NOW)
    for (const [recipient, since] of [['me', 5], ['someone-else', 0]] as const) {
      query.mockClear()
      await readNotificationWindow(window, recipient, since, passes, NOW)
      expect(reads('newest')).toHaveLength(10)
      expect(reads('newest')[0].startAfter).toBeUndefined()
    }
  })

  it('continues a window that became the previous one mid-pass, by its start', async () => {
    const { readNotificationWindow, window } = await load()
    const current = busyWindow(1_050)
    node({ [CURRENT]: current })
    const first = await readNotificationWindow(window, 'me', 0, [], NOW)

    // The grid moved on: the node's newest is the next window, and the clock names CURRENT as previous.
    node({ [CURRENT]: current }, CURRENT + STEP_MS)
    chainTime.ms = NOW + STEP_MS
    query.mockClear()
    const second = await readNotificationWindow(window, 'me', 0, first.passes, NOW + STEP_MS)
    expect(reads('byStart')).toEqual([expect.objectContaining({ startAfter: id(999), timeRange: [expect.objectContaining({ startMs: CURRENT })] })])
    expect(second.documents).toHaveLength(50)
    expect(second.watermarkLimit).toBe(NOW)
  })

  it('continues the previous window too', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [PREVIOUS]: Array.from({ length: 1_050 }, (_, n) => ({ $id: id(n), $createdAt: PREVIOUS + n })) })
    const first = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(first.watermarkLimit).toBe(0)
    query.mockClear()
    const second = await readNotificationWindow(window, 'me', 0, first.passes, NOW)
    expect(reads('byStart')).toEqual([expect.objectContaining({ startAfter: id(999), timeRange: [expect.objectContaining({ startMs: PREVIOUS })] })])
    expect(second.documents).toHaveLength(50)
    expect(second.watermarkLimit).toBe(NOW)
  })

  it('does not keep a `newest` pass that landed in the previous window (clock ahead at a boundary): that read covers it', async () => {
    const { readNotificationWindow, window } = await load()
    // The node's newest is still the window the clock calls previous.
    node({ [PREVIOUS]: Array.from({ length: 1_050 }, (_, n) => ({ $id: id(n), $createdAt: PREVIOUS + n })) }, PREVIOUS)
    chainTime.ms = CURRENT - 1_000
    const first = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(first.passes).toEqual([expect.objectContaining({ startMs: PREVIOUS })])
    query.mockClear()
    const second = await readNotificationWindow(window, 'me', 0, first.passes, NOW)
    // One continuation of that window (the previous read's), and a fresh `newest`.
    const previousReads = reads('byStart').filter((q) => q.timeRange[0].startMs === PREVIOUS)
    expect(previousReads.map((q) => q.startAfter)).toEqual([id(999)])
    expect(reads('newest')[0].startAfter).toBeUndefined()
    expect(second.watermarkLimit).toBe(0)
  })
})

describe('notification window reads at a boundary, where the clock and block time disagree', () => {
  const CURRENT = K * STEP_MS
  const PREVIOUS = (K - 1) * STEP_MS
  const reply = (id: string, createdAt: number) => ({ $id: id, $createdAt: createdAt })

  /** A node whose `newest` is the window holding `chainTime.ms`; `expiredBefore` refuses older windows as expired. */
  function node(byWindow: Record<number, Array<{ $id: string; $createdAt: number }>>, expiredBefore: number) {
    query.mockImplementation(async (q: Query) => {
      const pick = q.timeRange[0]
      const start = pick.selector === 'newest' ? Math.floor(chainTime.ms / STEP_MS) * STEP_MS : (pick.startMs ?? NaN)
      if (start < expiredBefore) throw new Error(`byStart ${start} is past the ttl horizon: expired windows are not queryable`)
      return byWindow[start] ?? []
    })
  }

  it('the clock behind: reads the clock\'s current window by its start, which the chain already calls previous', async () => {
    const { readNotificationWindow, window } = await load()
    // The chain is in the next window; the clock's previous one has expired.
    chainTime.ms = CURRENT + STEP_MS + 1_000
    node({ [CURRENT]: [reply('late-in-current', CURRENT + STEP_MS - 500)], [CURRENT + STEP_MS]: [reply('next', CURRENT + STEP_MS + 100)] }, CURRENT)
    const read = await readNotificationWindow(window, 'me', CURRENT + 1_000, [], NOW)
    expect(read.documents.map((doc) => doc.$id)).toEqual(['next', 'late-in-current'])
    expect(read.watermarkLimit).toBe(CURRENT + STEP_MS + 1_000)
  })

  it('the clock ahead: reads the window before the one `newest` named, when `since` reaches back into it', async () => {
    const { readNotificationWindow, window } = await load()
    // The chain is still in the window the clock calls previous.
    chainTime.ms = CURRENT - 1_000
    node({ [PREVIOUS - STEP_MS]: [reply('older', PREVIOUS - 500)], [PREVIOUS]: [reply('newest', CURRENT - 2_000)] }, PREVIOUS - STEP_MS)
    const read = await readNotificationWindow(window, 'me', 0, [], NOW)
    expect(read.documents.map((doc) => doc.$id)).toEqual(['newest', 'older'])
  })

  it('does not read a previous window that ended by `since` (the steady state)', async () => {
    const { readNotificationWindow, window } = await load()
    node({ [CURRENT]: [reply('new', NOW - 10)] }, 0)
    const read = await readNotificationWindow(window, 'me', CURRENT + 5, [], NOW)
    expect(query.mock.calls.map(([q]) => selectorOf(q as Query))).toEqual(['newest'])
    expect(read.documents.map((doc) => doc.$id)).toEqual(['new'])
  })

  it('refuses to go on from an answer without a block time', async () => {
    const { readNotificationWindow, window } = await load()
    chainTime.ms = NaN
    query.mockResolvedValue([])
    await expect(readNotificationWindow(window, 'me', 0, [], NOW)).rejects.toThrow('no block time')
  })
})
