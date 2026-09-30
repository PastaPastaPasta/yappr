import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))

beforeEach(() => {
  vi.resetModules()
  query.mockReset()
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

type Query = { timeRange: [{ selector: 'newest' | 'byStart'; startMs?: number }]; startAfter?: string }
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

const GRID = { range: 302_400, step: 302_400 }
const STEP_MS = 302_400_000
// 1.25 windows into window k: the previous window starts at (k - 1) steps.
const K = 5_920
const NOW = K * STEP_MS + STEP_MS / 4

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

  it('reads the current window and the previous one, one query each, and merges them', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 2)], byStart: [page(10, 3)] })
    const documents = await readNotificationWindow(window, 'me', 0, NOW)
    expect(query).toHaveBeenCalledTimes(2)
    const byStart = query.mock.calls.map(([q]) => q as Query).find((q) => selectorOf(q) === 'byStart')
    expect(byStart?.timeRange[0].startMs).toBe((K - 1) * STEP_MS)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-0', 'doc-1', 'doc-10', 'doc-11', 'doc-12'])
  })

  it('counts a previous window the node refuses as expired (clock ahead at a boundary) as empty, and fails on anything else', async () => {
    const { readNotificationWindow, window } = await load()
    query.mockImplementation(async (q: Query) => {
      if (selectorOf(q) === 'byStart') throw new Error('query for an expired time-range window')
      return page(0, 2)
    })
    expect((await readNotificationWindow(window, 'me', 0, NOW)).map((doc) => doc.$id)).toEqual(['doc-0', 'doc-1'])
    query.mockImplementation(async (q: Query) => {
      if (selectorOf(q) === 'byStart') throw new Error('DAPI unavailable')
      return page(0, 2)
    })
    await expect(readNotificationWindow(window, 'me', 0, NOW)).rejects.toThrow('DAPI unavailable')
  })

  it('dedupes by id', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 3)], byStart: [page(0, 3)] })
    const documents = await readNotificationWindow(window, 'me', 0, NOW)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-0', 'doc-1', 'doc-2'])
  })

  it('pages a full window by its last document id, up to ten pages per window', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: Array.from({ length: 12 }, (_, i) => page(i * 100, 100)), byStart: [page(5_000, 4)] })
    const documents = await readNotificationWindow(window, 'me', 0, NOW)
    expect(documents).toHaveLength(1_004)
    const newest = query.mock.calls.map(([q]) => q as Query).filter((q) => selectorOf(q) === 'newest')
    expect(newest).toHaveLength(10)
    expect(newest.slice(0, 3).map((q) => q.startAfter)).toEqual([undefined, 'doc-99', 'doc-199'])
  })

  it('filters strictly after `since` client-side, in both windows', async () => {
    const { readNotificationWindow, window } = await load()
    windows({
      newest: [page(0, 3, (i) => [500, 1_500, 1_000][i])],
      byStart: [page(3, 2, (i) => [2_000, 999][i - 3])],
    })
    const documents = await readNotificationWindow(window, 'me', 1_000, NOW)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-1', 'doc-3'])
  })
})
