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

const page = (from: number, length: number, createdAt = (i: number) => 1_000 + i) =>
  Array.from({ length }, (_, i) => ({ $id: `doc-${from + i}`, $createdAt: createdAt(from + i) }))

describe('notification window reads', () => {
  it('pins the recipient and names the oldest open window on the contract grid, with no time clause or orderBy', async () => {
    const { notificationWindowQuery, window } = await load()
    const first = notificationWindowQuery(window, 'me')
    expect(first).toEqual({
      dataContractId: expect.any(String),
      documentTypeName: 'reply',
      where: [['parentOwnerId', '==', 'me']],
      timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range: 604_800, step: 86_400 } }],
      limit: 100,
    })
    expect(notificationWindowQuery(window, 'me', 'doc-99')).toMatchObject({ startAfter: 'doc-99' })
  })

  it('pages a full window by the last document id, up to three pages', async () => {
    const { readNotificationWindow, window } = await load()
    query
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 100))
      .mockResolvedValueOnce(page(200, 100))
    const documents = await readNotificationWindow(window, 'me', 0)
    expect(documents).toHaveLength(300)
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls.map(([q]) => q.startAfter)).toEqual([undefined, 'doc-99', 'doc-199'])
  })

  it('stops on a short page, and filters strictly after `since` client-side', async () => {
    const { readNotificationWindow, window } = await load()
    query.mockResolvedValueOnce(page(0, 5, (i) => [500, 1_500, 1_000, 2_000, 999][i]))
    const documents = await readNotificationWindow(window, 'me', 1_000)
    expect(query).toHaveBeenCalledTimes(1)
    expect(documents.map((doc) => doc.$id)).toEqual(['doc-1', 'doc-3'])
  })
})
