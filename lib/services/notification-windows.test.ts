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

type Query = { timeRange: [{ selector: 'newest' | 'oldest' }]; startAfter?: string }
const selectorOf = (q: Query) => q.timeRange[0].selector

const page = (from: number, length: number, createdAt = (i: number) => 1_000 + i) =>
  Array.from({ length }, (_, i) => ({ $id: `doc-${from + i}`, $createdAt: createdAt(from + i) }))

/** Answers each window from its own pages, in call order per window. */
function windows(pages: Record<'newest' | 'oldest', Record<string, unknown>[][]>) {
  const served = { newest: 0, oldest: 0 }
  query.mockImplementation(async (q: Query) => {
    const selector = selectorOf(q)
    return pages[selector][served[selector]++] ?? []
  })
}

const GRID = { range: 302_400, step: 302_400 }

describe('notification window reads', () => {
  it('pins the recipient and names one window on the contract grid, with no time clause or orderBy', async () => {
    const { notificationWindowQuery, window } = await load()
    expect(window.selectors).toEqual(['newest', 'oldest'])
    expect(notificationWindowQuery(window, 'newest', 'me')).toEqual({
      dataContractId: expect.any(String),
      documentTypeName: 'reply',
      where: [['parentOwnerId', '==', 'me']],
      timeRange: [{ field: '$createdAt', selector: 'newest', grid: GRID }],
      limit: 100,
    })
    expect(notificationWindowQuery(window, 'oldest', 'me', 'doc-99')).toMatchObject({
      timeRange: [{ field: '$createdAt', selector: 'oldest', grid: GRID }],
      startAfter: 'doc-99',
    })
  })

  it('reads the current and the previous window, one query each, and merges them', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 2)], oldest: [page(10, 3)] })
    const documents = await readNotificationWindow(window, 'me', 0)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.map(([q]) => selectorOf(q)).sort()).toEqual(['newest', 'oldest'])
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-0', 'doc-1', 'doc-10', 'doc-11', 'doc-12'])
  })

  it('dedupes by id when both selectors resolve to the same window', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 3)], oldest: [page(0, 3)] })
    const documents = await readNotificationWindow(window, 'me', 0)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-0', 'doc-1', 'doc-2'])
  })

  it('pages a full window by its last document id, up to three pages per window', async () => {
    const { readNotificationWindow, window } = await load()
    windows({ newest: [page(0, 100), page(100, 100), page(200, 100)], oldest: [page(1_000, 4)] })
    const documents = await readNotificationWindow(window, 'me', 0)
    expect(documents).toHaveLength(304)
    const newest = query.mock.calls.map(([q]) => q as Query).filter((q) => selectorOf(q) === 'newest')
    expect(newest.map((q) => q.startAfter)).toEqual([undefined, 'doc-99', 'doc-199'])
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('filters strictly after `since` client-side, in both windows', async () => {
    const { readNotificationWindow, window } = await load()
    windows({
      newest: [page(0, 3, (i) => [500, 1_500, 1_000][i])],
      oldest: [page(3, 2, (i) => [2_000, 999][i - 3])],
    })
    const documents = await readNotificationWindow(window, 'me', 1_000)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-1', 'doc-3'])
  })
})
