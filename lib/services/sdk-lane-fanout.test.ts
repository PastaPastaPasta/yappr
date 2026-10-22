import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import { installLaneFanout, resetLaneCursorsForTests } from './sdk-lane-fanout'

type Where = [string, string, unknown]

interface FakeDoc {
  $id: string
  $ownerId: string
  $createdAt: number
  live: number
  mod?: number
}

/** A valid 32-byte identifier in base58, distinct per seed. */
const identifier = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed))
const hexOf = (id: string) => Buffer.from(bs58.decode(id)).toString('hex')

const laneOf = (where: Where[] | undefined) => ({
  live: where?.find((clause) => clause[0] === 'live')?.[2],
  mod: where?.find((clause) => clause[0] === 'mod')?.[2] ?? null,
})

/** Seven posts in four lanes: the listed lane holds the newest and the oldest. */
const STORE: FakeDoc[] = [
  { $id: identifier(1), $ownerId: identifier(90), $createdAt: 100, live: 1 },
  { $id: identifier(2), $ownerId: identifier(90), $createdAt: 99, live: 2 },
  { $id: identifier(3), $ownerId: identifier(91), $createdAt: 95, live: 1, mod: 1 },
  { $id: identifier(4), $ownerId: identifier(91), $createdAt: 90, live: 1 },
  { $id: identifier(5), $ownerId: identifier(90), $createdAt: 85, live: 1, mod: 2 },
  { $id: identifier(6), $ownerId: identifier(91), $createdAt: 80, live: 1 },
  { $id: identifier(7), $ownerId: identifier(90), $createdAt: 70, live: 2, mod: 1 },
]
const idsOf = (docs: Iterable<{ $id: string }>) => Array.from(docs, (doc) => doc.$id)

/** What Drive does with one lane: filter by the pins, order newest first, start after a cursor, cap at `limit`. */
function readLane(request: { where?: Where[]; startAfter?: string; limit?: number }): Map<string, FakeDoc> {
  const { live, mod } = laneOf(request.where)
  let docs = STORE.filter((doc) => doc.live === live && (doc.mod ?? null) === mod).sort((a, b) => b.$createdAt - a.$createdAt)
  if (request.startAfter) {
    const at = docs.findIndex((doc) => doc.$id === request.startAfter)
    docs = docs.slice(at + 1)
  }
  return new Map(docs.slice(0, request.limit ?? 100).map((doc) => [doc.$id, doc]))
}

const LISTED: Where[] = [['live', '==', 1], ['mod', '==', null], ['$createdAt', '>', 0]]
const NEWEST_FIRST: [string, string][] = [['$createdAt', 'desc']]

function fakeSdk() {
  const documents = {
    query: vi.fn(async (request: { where?: Where[]; startAfter?: string; limit?: number }) => readLane(request)),
    count: vi.fn(async (_request: { where?: Where[] }) => new Map<string, bigint>()),
    average: vi.fn(async (_request: { where?: Where[] }, _property: string) => new Map<string, { count: bigint; sum: bigint }>()),
    ranked: vi.fn(async (_request: { where?: Where[] }) => ({ entries: [] as unknown[], startingRank: 0n, valueScale: 1n })),
    composite: vi.fn(async (_request: unknown) => ({ pageDocuments: [] as unknown[], subResults: [] as unknown[] })),
  }
  // Installing the fan-out replaces the facade's methods, so the spies are kept apart.
  return { documents, spies: { ...documents }, sdk: { documents } as unknown as EvoSDK }
}

beforeEach(() => {
  resetLaneCursorsForTests()
  vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
})
afterEach(() => vi.unstubAllEnvs())

describe('installLaneFanout, flag off', () => {
  it('shadows nothing: the facade keeps its own methods and reads go straight through', async () => {
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', '')
    const { documents, sdk } = fakeSdk()
    const before = { ...documents }
    installLaneFanout(sdk)
    expect(documents).toEqual(before)
    for (const name of Object.keys(before) as (keyof typeof before)[]) expect(documents[name]).toBe(before[name])
    await sdk.documents.query({ dataContractId: 'c', documentTypeName: 'post', where: LISTED, orderBy: NEWEST_FIRST, limit: 5 } as never)
    expect(documents.query).toHaveBeenCalledTimes(1)
  })
})

describe('installLaneFanout, flag on', () => {
  it('sends a listing once per lane and merges the pages in the request\'s order', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.query
    installLaneFanout(sdk)
    const result = await sdk.documents.query({ dataContractId: 'c', documentTypeName: 'post', where: LISTED, orderBy: NEWEST_FIRST, limit: 10 } as never)
    expect(original).toHaveBeenCalledTimes(6)
    const lanes = original.mock.calls.map(([request]) => laneOf(request.where))
    expect(lanes[0]).toEqual({ live: 1, mod: null })
    expect(lanes).toHaveLength(new Set(lanes.map((lane) => `${lane.live}/${lane.mod}`)).size)
    expect(Array.from(result.keys())).toEqual(STORE.map((doc) => doc.$id))
  })

  it('pages on with each lane\'s own cursor', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.query
    installLaneFanout(sdk)
    const request = { dataContractId: 'c', documentTypeName: 'post', where: LISTED, orderBy: NEWEST_FIRST, limit: 3 }

    const first = Array.from((await sdk.documents.query(request as never)).keys())
    expect(first).toEqual([STORE[0].$id, STORE[1].$id, STORE[2].$id])

    original.mockClear()
    const second = Array.from((await sdk.documents.query({ ...request, startAfter: first[2] } as never)).keys())
    expect(second).toEqual([STORE[3].$id, STORE[4].$id, STORE[5].$id])
    // Each lane resumes after its own last document taken, not after the merged page's last id.
    const cursors = new Map(original.mock.calls.map(([call]) => {
      const lane = laneOf(call.where)
      return [`${lane.live}/${lane.mod}`, call.startAfter]
    }))
    expect(cursors.get('1/null')).toBe(STORE[0].$id)
    // Lanes that ran dry on the first page are not read again; lanes it never took from start where they began.
    expect(Array.from(cursors.keys()).sort()).toEqual(['1/2', '1/null', '2/1'])
    expect(cursors.get('1/2')).toBeUndefined()
    expect(cursors.get('2/1')).toBeUndefined()

    const third = Array.from((await sdk.documents.query({ ...request, startAfter: second[2] } as never)).keys())
    expect(third).toEqual([STORE[6].$id])
  })

  it('pages the same ascending order too, and drops a lane once it ran dry', async () => {
    const { documents, sdk } = fakeSdk()
    // An ascending store: reverse what the fake returns.
    documents.query.mockImplementation(async (request) => {
      const lane = laneOf(request.where)
      let docs = STORE.filter((doc) => doc.live === lane.live && (doc.mod ?? null) === lane.mod).sort((a, b) => a.$createdAt - b.$createdAt)
      if (request.startAfter) docs = docs.slice(docs.findIndex((doc) => doc.$id === request.startAfter) + 1)
      return new Map(docs.slice(0, request.limit ?? 100).map((doc) => [doc.$id, doc]))
    })
    installLaneFanout(sdk)
    const request = { dataContractId: 'c', documentTypeName: 'post', where: LISTED, orderBy: [['$createdAt', 'asc']], limit: 4 }
    const first = Array.from((await sdk.documents.query(request as never)).keys())
    expect(first).toEqual([STORE[6].$id, STORE[5].$id, STORE[4].$id, STORE[3].$id])
    const second = Array.from((await sdk.documents.query({ ...request, startAfter: first[3] } as never)).keys())
    expect(second).toEqual([STORE[2].$id, STORE[1].$id, STORE[0].$id])
  })

  it('continues from the listed lane only when it has no cursors for the page', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.query
    installLaneFanout(sdk)
    await sdk.documents.query({ dataContractId: 'c', documentTypeName: 'post', where: LISTED, orderBy: NEWEST_FIRST, limit: 3, startAfter: identifier(55) } as never)
    expect(original).toHaveBeenCalledTimes(1)
    expect(laneOf(original.mock.calls[0][0].where)).toEqual({ live: 1, mod: null })
  })

  it('does not fan out a read that pins no lane', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.query
    installLaneFanout(sdk)
    const request = { dataContractId: 'c', documentTypeName: 'post', where: [['live', '==', true], ['$createdAt', '>', 0]], orderBy: NEWEST_FIRST, limit: 3 }
    await sdk.documents.query(request as never)
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith(request)
    const log = { dataContractId: 'c', documentTypeName: 'post', where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], limit: 3 }
    await sdk.documents.query(log as never)
    expect(original).toHaveBeenCalledTimes(2)
  })

  it('sums a count over the lanes', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.count
    original.mockImplementation(async (request) => new Map([['total', BigInt(readLane(request).size)]]))
    installLaneFanout(sdk)
    const counts = await sdk.documents.count({ dataContractId: 'c', documentTypeName: 'post', where: [['live', '==', 1], ['mod', '==', null]] } as never)
    expect(original).toHaveBeenCalledTimes(6)
    expect(counts.get('total')).toBe(BigInt(STORE.length))
  })

  it('sums an average\'s count and sum over the lanes', async () => {
    const { documents, sdk } = fakeSdk()
    const original = documents.average
    const ratings = new Map<string, { count: bigint; sum: bigint }[]>([['null', [{ count: 2n, sum: 10n }]], ['1', [{ count: 1n, sum: 1n }]], ['2', []]])
    original.mockImplementation(async (request) => {
      const entry = ratings.get(String(laneOf(request.where).mod))?.[0]
      return new Map(entry ? [['store', entry]] : [])
    })
    installLaneFanout(sdk)
    const totals = await sdk.documents.average({ dataContractId: 'c', documentTypeName: 'storeReview', where: [['mod', '==', null], ['storeId', '==', 'S']] } as never, 'rating')
    expect(original).toHaveBeenCalledTimes(3)
    expect(totals.get('store')).toEqual({ count: 3n, sum: 11n })
  })

  describe('ranked', () => {
    const entry = (seed: number, value: bigint) => ({ groupKeyHex: hexOf(identifier(seed)), groupValue: identifier(seed), value, valueAsNumber: Number(value), rank: 0n })

    it('sums the groups of every lane and ranks them again', async () => {
      const { documents, sdk } = fakeSdk()
      const original = documents.ranked
      const perLane = new Map([
        ['1/null', [entry(1, 5n), entry(2, 4n)]],
        ['1/1', [entry(2, 3n), entry(3, 6n)]],
        ['2/null', [entry(1, 1n)]],
      ])
      original.mockImplementation(async (request) => {
        const lane = laneOf(request.where)
        return { entries: perLane.get(`${lane.live}/${lane.mod}`) ?? [], startingRank: 0n, valueScale: 1n }
      })
      installLaneFanout(sdk)
      const result = await sdk.documents.ranked({
        dataContractId: 'c', documentTypeName: 'reply', groupBy: 'rootPostId',
        aggregate: { type: 'count' }, direction: 'desc', limit: 2,
        where: [['live', '==', 1], ['mod', '==', null]],
      } as never)
      expect(original).toHaveBeenCalledTimes(6)
      // g1 = 5 + 1, g2 = 4 + 3, g3 = 6: g2 leads, and g1 and g3 tie for the second place in first-seen order.
      expect(result.entries.map((row) => [row.groupValue, row.value, row.rank])).toEqual([
        [identifier(2), 7n, 0n],
        [identifier(1), 6n, 1n],
      ])
    })

    it('ranks ascending when asked', async () => {
      const { documents, sdk } = fakeSdk()
      documents.ranked.mockImplementation(async (request) => ({
        entries: laneOf(request.where).mod === null ? [entry(1, 5n), entry(2, 1n)] : [entry(2, 1n)],
        startingRank: 0n, valueScale: 1n,
      }))
      installLaneFanout(sdk)
      const result = await sdk.documents.ranked({
        dataContractId: 'c', documentTypeName: 'reply', groupBy: 'rootPostId',
        aggregate: { type: 'count' }, direction: 'asc', limit: 5, where: [['mod', '==', null]],
      } as never)
      expect(result.entries.map((row) => [row.groupValue, row.value])).toEqual([[identifier(2), 3n], [identifier(1), 5n]])
    })

    it('re-averages an average ranking from each lane\'s count and sum', async () => {
      const { documents, spies, sdk } = fakeSdk()
      // Store 1: two listed reviews, 5 stars each. Store 2: one listed 3-star review, and a hidden 5-star one.
      documents.ranked.mockImplementation(async (request) => ({
        entries: laneOf(request.where).mod === null ? [entry(1, 500n), entry(2, 300n)] : laneOf(request.where).mod === 1 ? [entry(2, 500n)] : [],
        startingRank: 0n, valueScale: 100n,
      }))
      const readings: Record<string, Map<string, { count: bigint; sum: bigint }>> = {
        null: new Map([[hexOf(identifier(1)).toUpperCase(), { count: 2n, sum: 10n }], [hexOf(identifier(2)), { count: 1n, sum: 3n }]]),
        '1': new Map([[hexOf(identifier(2)), { count: 1n, sum: 5n }]]),
        '2': new Map(),
      }
      documents.average.mockImplementation(async (request) => readings[String(laneOf(request.where).mod)])
      installLaneFanout(sdk)
      const result = await sdk.documents.ranked({
        dataContractId: 'c', documentTypeName: 'storeReview', groupBy: 'storeId',
        aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 2, where: [['mod', '==', null]],
      } as never)
      expect(spies.average).toHaveBeenCalledTimes(3)
      const [, property] = spies.average.mock.calls[0]
      expect(property).toBe('rating')
      const request = spies.average.mock.calls[0][0] as { where: Where[] }
      expect(request.where.at(-1)).toEqual(['storeId', 'in', [identifier(1), identifier(2)]])
      // Store 1 averages 5.00; store 2, (3 + 5) / 2 = 4.00, no longer the 3.00 its listed review alone gave.
      expect(result.entries.map((row) => [row.groupValue, row.value, row.valueAsNumber])).toEqual([
        [identifier(1), 500n, 5],
        [identifier(2), 400n, 4],
      ])
    })
  })

  it('re-reads an average ranking\'s groups in batches no larger than one `in` clause', async () => {
    const { documents, spies, sdk } = fakeSdk()
    // Three lanes, each ranking its own 60 groups: 180 distinct groups to re-average.
    const groupEntry = (seed: number) => ({ groupKeyHex: hexOf(identifier(seed)), groupValue: identifier(seed), value: 400n, valueAsNumber: 4, rank: 0n })
    const laneSeeds: Record<string, number[]> = { null: [], '1': [], '2': [] }
    Object.keys(laneSeeds).forEach((lane, at) => { laneSeeds[lane] = Array.from({ length: 60 }, (_, i) => 1 + at * 60 + i) })
    documents.ranked.mockImplementation(async (request) => ({
      entries: (laneSeeds[String(laneOf(request.where).mod)] ?? []).map(groupEntry), startingRank: 0n, valueScale: 100n,
    }))
    // Every group has one 4-star review in the listed lane and one 2-star review in lane 1: 3 stars on average.
    documents.average.mockImplementation(async (request) => {
      const mod = laneOf(request.where).mod
      const wanted = (request.where?.at(-1)?.[2] ?? []) as string[]
      return new Map(mod === null || mod === 1 ? wanted.map((id) => [hexOf(id), { count: 1n, sum: mod === null ? 4n : 2n }]) : [])
    })
    installLaneFanout(sdk)
    const result = await sdk.documents.ranked({
      dataContractId: 'c', documentTypeName: 'storeReview', groupBy: 'storeId',
      aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 100, where: [['mod', '==', null]],
    } as never)

    const sizes = spies.average.mock.calls.map(([request]) => ((request as { where: Where[] }).where.at(-1)?.[2] as string[]).length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100)
    // 180 groups: two batches (100 + 80) in each of the three lanes.
    expect(sizes.sort((a, b) => a - b)).toEqual([80, 80, 80, 100, 100, 100])
    expect(result.entries).toHaveLength(100)
    // Batches add up with the lanes: (4 + 2) / 2 = 3.00 for every group.
    expect(new Set(result.entries.map((row) => row.value))).toEqual(new Set([300n]))
  })

  describe('composite', () => {
    const subQueries = [
      { documentType: 'reply', kind: 'counts', where: [['live', '==', 1], ['mod', '==', null]], bind: { source: 'page', sourceProperty: '$id', field: 'rootPostId' } },
    ]
    const page = { dataContractId: 'c', documentType: 'post', where: LISTED, orderBy: NEWEST_FIRST, limit: 4, subQueries }

    it('resolves the page by the merged ids and sums the laned count sub-query', async () => {
      const { documents, spies, sdk } = fakeSdk()
      const original = documents.composite
      // The by-id page returns documents in key order, with the listed lane's counts.
      original.mockImplementation(async () => ({
        pageDocuments: [STORE[3], STORE[0], STORE[2], STORE[1]],
        subResults: [{ kind: 'counts', counts: new Map([[STORE[0].$id, 2n]]) }],
      }))
      // The other lanes' grouped counts arrive keyed by the bound value's hex.
      documents.count.mockImplementation(async (request) => {
        const lane = laneOf(request.where)
        return lane.live === 1 && lane.mod === 1 ? new Map([[hexOf(STORE[0].$id), 1n], [hexOf(STORE[2].$id), 4n]]) : new Map()
      })
      installLaneFanout(sdk)
      const result = await sdk.documents.composite(page as never)

      // The page came from the lanes: the four newest posts, fetched by id.
      const sent = original.mock.calls[0][0] as { where: Where[]; orderBy?: unknown }
      expect(sent.where).toEqual([['$id', 'in', [STORE[0].$id, STORE[1].$id, STORE[2].$id, STORE[3].$id]]])
      expect(sent.orderBy).toBeUndefined()
      expect(idsOf(result.pageDocuments as unknown as FakeDoc[])).toEqual([STORE[0].$id, STORE[1].$id, STORE[2].$id, STORE[3].$id])

      // Five other lanes of the sub-query, each bound to the page's ids.
      expect(spies.count).toHaveBeenCalledTimes(5)
      const lane = spies.count.mock.calls[0][0] as { where: Where[]; groupBy: string[] }
      expect(lane.groupBy).toEqual(['rootPostId'])
      expect(lane.where.at(-1)).toEqual(['rootPostId', 'in', [STORE[0].$id, STORE[1].$id, STORE[2].$id, STORE[3].$id]])
      const counts = (result.subResults[0] as { counts: Map<string, bigint> }).counts
      expect(counts.get(STORE[0].$id)).toBe(3n)
      expect(counts.get(STORE[2].$id)).toBe(4n)
    })

    it('answers an empty merged page without reading by id', async () => {
      const { documents, spies, sdk } = fakeSdk()
      documents.query.mockResolvedValue(new Map())
      installLaneFanout(sdk)
      const result = await sdk.documents.composite({ ...page, subQueries: [...subQueries, { documentType: 'profile', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } }] } as never)
      expect(spies.composite).not.toHaveBeenCalled()
      expect(result.pageDocuments).toEqual([])
      expect(result.subResults).toEqual([
        { kind: 'counts', counts: new Map() },
        { kind: 'documents', documents: [], missingIds: [], removed: [] },
      ])
    })

    it('passes a by-id page with unlaned sub-queries straight through', async () => {
      const { spies, sdk } = fakeSdk()
      installLaneFanout(sdk)
      const request = { dataContractId: 'c', documentType: 'post', where: [['$id', 'in', [STORE[0].$id]]], limit: 1, subQueries: [{ documentType: 'profile', bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } }] }
      await sdk.documents.composite(request as never)
      expect(spies.composite).toHaveBeenCalledWith(request)
      expect(spies.query).not.toHaveBeenCalled()
    })
  })
})
