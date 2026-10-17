import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryDocumentsOptions } from './sdk-helpers'

const { bundle, getByOwner, getAllByStore, paginateFetchAll } = vi.hoisted(() => ({
  bundle: vi.fn(),
  getByOwner: vi.fn(),
  getAllByStore: vi.fn(),
  paginateFetchAll: vi.fn(),
}))
vi.mock('./document-query-bundle', () => ({ queryDocumentBundle: bundle }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn(async () => ({})) }))
vi.mock('./store-service', () => ({ storeService: { getByOwner } }))
vi.mock('./store-item-service', () => ({ storeItemService: { getAllByStore } }))
vi.mock('./pagination-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pagination-utils')>()),
  paginateFetchAll,
}))

const BUYER = 'Hw4EfsztcFJEypi5vpg8EqiCmy9aD25Dga9NRhtDwm6J'
const SELLER = '7sGmWnXr4iaMvzKTsqbJFMmMyDeBHJ4zqCYv7Bg94134'
const STORE = '74CFXitPeRzk71js9CwN4vCRSvVpVmdx6gHovW6SPSrq'
const ITEM = '9yQpMwZMJkRbBQwhZbthsWKPEXKowCnywxGoKek16qjg'
const NEW_ITEM = '2XqDQ6S3nmz5P1vmdJ832zTZghG7VRKLTtH17FyxcW4R'
const SINCE = 1_000

type Doc = Record<string, unknown>
const doc = (id: string, ownerId: string, createdAt: number, fields: Doc = {}): Doc =>
  ({ $id: id, $ownerId: ownerId, $createdAt: createdAt, ...fields })

/** Answers each bundled query by its document type (an `in` read by the item ids it names). */
function answer(rows: Partial<Record<string, Doc[]>>) {
  bundle.mockImplementation(async (queries: QueryDocumentsOptions[]) => queries.map((query) => {
    if (query.documentTypeName === 'itemReview') {
      const ids = query.where?.[0][2] as string[]
      return (rows.itemReview ?? []).filter((row) => ids.includes(row.itemId as string))
    }
    return rows[query.documentTypeName] ?? []
  }))
}

const bundled = (call: number) => (bundle.mock.calls[call] as [QueryDocumentsOptions[]])[0]
const shapes = (queries: QueryDocumentsOptions[]) => queries.map((query) => [query.documentTypeName, query.where?.[0]])

async function service() {
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v9')
  vi.resetModules()
  return (await import('./store-notification-service')).storeNotificationService
}

const sellerStore = { id: STORE, createdAt: new Date(100) }

beforeEach(() => {
  bundle.mockReset()
  getByOwner.mockReset().mockResolvedValue(null)
  getAllByStore.mockReset().mockResolvedValue([{ id: ITEM, title: 'Blue mug', createdAt: new Date(500) }])
  paginateFetchAll.mockReset()
  answer({})
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('store notifications', () => {
  it('tells a buyer about status changes off buyerFeed', async () => {
    answer({
      orderStatusUpdate: [
        doc('Upd1', SELLER, 5_000, { orderId: 'Order1', status: 'shipped', message: '  On its way!  ', trackingNumber: '1Z' }),
        doc('Upd2', SELLER, 4_000, { orderId: 'Order1', status: 'payment_received' }),
        doc('Upd3', SELLER, 3_000, { orderId: 'Order1', status: 'teleported' }),
      ],
    })
    const stores = await service()

    const events = await stores.getNotifications(BUYER, SINCE, vi.fn())

    expect(bundle).toHaveBeenCalledTimes(1)
    const [feed, ...rest] = bundled(0)
    expect(rest).toEqual([])
    expect(getByOwner).toHaveBeenCalledWith(BUYER)
    expect(feed).toMatchObject({
      documentTypeName: 'orderStatusUpdate',
      where: [['orderId.$ownerId', '==', BUYER], ['$createdAt', '>', SINCE]],
      orderBy: [['orderId.$ownerId', 'asc'], ['$createdAt', 'desc']],
    })
    // An unknown status is not announced; the tracking number is not carried.
    expect(events).toEqual([
      { id: 'orderStatus-Upd1', type: 'orderStatus', fromUserId: SELLER, createdAt: 5_000, store: { status: 'shipped', text: 'On its way!' } },
      { id: 'orderStatus-Upd2', type: 'orderStatus', fromUserId: SELLER, createdAt: 4_000, store: { status: 'payment_received' } },
    ])
    expect(getAllByStore).not.toHaveBeenCalled()
  })

  it('tells a seller about orders and reviews on their store, without any of the order\'s encrypted contents', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    answer({
      storeOrder: [doc('Ord1', BUYER, 2_000, { storeId: STORE, sellerId: SELLER, encryptedPayload: [1, 2, 3], nonce: [4] })],
      storeReview: [doc('Rev1', BUYER, 3_000, { storeId: STORE, rating: 4, title: 'Great', content: 'Fast shipping' })],
      itemReview: [doc('IRev1', BUYER, 4_000, { storeId: STORE, itemId: ITEM, rating: 5, content: 'Love it' })],
    })
    const stores = await service()

    const events = await stores.getNotifications(SELLER, SINCE, vi.fn())

    // One bundle: the buyer feed and the seller's sources, from the watermark.
    expect(bundle).toHaveBeenCalledTimes(1)
    expect(shapes(bundled(0))).toEqual([
      ['orderStatusUpdate', ['orderId.$ownerId', '==', SELLER]],
      ['storeOrder', ['storeId', '==', STORE]],
      ['storeReview', ['storeId', '==', STORE]],
      ['storeItem', ['storeId', '==', STORE]],
      ['itemReview', ['itemId', 'in', [ITEM]]],
    ])
    expect(bundled(0).map((query) => query.where?.[1])).toEqual([
      ['$createdAt', '>', SINCE], ['$createdAt', '>', SINCE], ['$createdAt', '>', SINCE], ['$createdAt', '>', 500], ['$createdAt', '>', SINCE],
    ])
    // Every member walks newest first, an `in` key included, as a composite requires.
    expect(bundled(0).map((query) => query.orderBy)).toEqual([
      [['orderId.$ownerId', 'asc'], ['$createdAt', 'desc']], [['storeId', 'asc'], ['$createdAt', 'desc']], [['storeId', 'asc'], ['$createdAt', 'desc']],
      [['storeId', 'asc'], ['$createdAt', 'desc']], [['itemId', 'desc'], ['$createdAt', 'desc']],
    ])
    expect(events).toEqual([
      { id: 'storeOrder-Ord1', type: 'storeOrder', fromUserId: BUYER, createdAt: 2_000, store: { storeId: STORE } },
      { id: 'storeReview-Rev1', type: 'storeReview', fromUserId: BUYER, createdAt: 3_000, store: { storeId: STORE, rating: 4, text: 'Great — Fast shipping' } },
      { id: 'itemReview-IRev1', type: 'itemReview', fromUserId: BUYER, createdAt: 4_000, store: { storeId: STORE, rating: 5, text: 'Love it', itemId: ITEM, itemTitle: 'Blue mug' } },
    ])
  })

  it('keeps a found store and its items, so a later poll is one bundle with the buyer feed', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    const stores = await service()
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    bundle.mockClear()

    await stores.getNotifications(SELLER, 2_000, vi.fn())

    expect(bundle).toHaveBeenCalledTimes(1)
    expect(shapes(bundled(0)).map(([type]) => type)).toEqual(['orderStatusUpdate', 'storeOrder', 'storeReview', 'storeItem', 'itemReview'])
    expect(getAllByStore).toHaveBeenCalledTimes(1)
  })

  it('reads the reviews of an item listed since the last read, from the same watermark, and names it', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    const stores = await service()
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    answer({
      storeItem: [doc(NEW_ITEM, SELLER, 6_000, { storeId: STORE, title: 'Red mug' })],
      itemReview: [doc('IRev2', BUYER, 7_000, { storeId: STORE, itemId: NEW_ITEM, rating: 3 })],
    })
    bundle.mockClear()

    const events = await stores.getNotifications(SELLER, 5_000, vi.fn())

    expect(shapes(bundled(1))).toEqual([['itemReview', ['itemId', 'in', [NEW_ITEM]]]])
    expect(bundled(1)[0].where?.[1]).toEqual(['$createdAt', '>', 5_000])
    expect(events).toEqual([
      { id: 'itemReview-IRev2', type: 'itemReview', fromUserId: BUYER, createdAt: 7_000, store: { storeId: STORE, rating: 3, itemId: NEW_ITEM, itemTitle: 'Red mug' } },
    ])
    // The next poll looks for items after the newest one it holds.
    bundle.mockClear()
    await stores.getNotifications(SELLER, 7_000, vi.fn())
    expect(bundled(0).find((query) => query.documentTypeName === 'storeItem')?.where?.[1]).toEqual(['$createdAt', '>', 6_000])
  })

  it('looks a user without a store up again only every few minutes, and reads a store found late from its creation', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    try {
      const stores = await service()
      await stores.getNotifications(SELLER, SINCE, vi.fn())
      await stores.getNotifications(SELLER, 2_000, vi.fn())
      expect(getByOwner).toHaveBeenCalledTimes(1)

      vi.setSystemTime(1_000_000 + 5 * 60 * 1000)
      getByOwner.mockResolvedValue({ id: STORE, createdAt: new Date(1_500) })
      bundle.mockClear()
      await stores.getNotifications(SELLER, 3_000, vi.fn())

      expect(getByOwner).toHaveBeenCalledTimes(2)
      // The polls that found no store did not read it: from its creation, not the watermark.
      expect(bundled(0).find((query) => query.documentTypeName === 'storeOrder')?.where?.[1]).toEqual(['$createdAt', '>', 1_499])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps reading a store found late from its creation until a poll of it succeeds', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    try {
      const stores = await service()
      await stores.getNotifications(SELLER, SINCE, vi.fn())
      vi.setSystemTime(1_000_000 + 5 * 60 * 1000)
      getByOwner.mockResolvedValue({ id: STORE, createdAt: new Date(1_500) })
      // The discovery poll's order read fails.
      bundle.mockImplementation(async (queries: QueryDocumentsOptions[], _tolerate: boolean, failed?: (error: unknown) => void) => {
        if (queries.some((query) => query.documentTypeName === 'storeOrder')) failed?.(new Error('quorum'))
        return queries.map(() => [])
      })
      const onFailure = vi.fn()
      await stores.getNotifications(SELLER, 3_000, onFailure)
      expect(onFailure).toHaveBeenCalled()

      const orderAfter = () => bundled(bundle.mock.calls.length - 1).find((query) => query.documentTypeName === 'storeOrder')?.where?.[1]
      // The watermark moved on (another source), but the store is still read from its creation.
      answer({})
      await stores.getNotifications(SELLER, 9_000, vi.fn())
      expect(orderAfter()).toEqual(['$createdAt', '>', 1_499])
      // That poll succeeded: from the watermark on.
      await stores.getNotifications(SELLER, 10_000, vi.fn())
      expect(orderAfter()).toEqual(['$createdAt', '>', 10_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the whole item list again when a read of new items stops short, and keeps its boundary when that fails', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    const stores = await service()
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    const storeItemAfter = () => bundled(bundle.mock.calls.length - 1).find((query) => query.documentTypeName === 'storeItem')?.where?.[1]

    // 100 new items, and the read on past them fails; the full read fails too.
    answer({ storeItem: Array.from({ length: 100 }, (_, i) => doc(`New${i}`, SELLER, 9_000 - i, { title: `New ${i}` })) })
    paginateFetchAll.mockRejectedValue(new Error('quorum'))
    getAllByStore.mockRejectedValueOnce(new Error('quorum'))
    const onFailure = vi.fn()
    await stores.getNotifications(SELLER, 5_000, onFailure)
    expect(onFailure).toHaveBeenCalled()
    answer({})
    await stores.getNotifications(SELLER, 5_000, vi.fn())
    // Nothing was folded in: the next poll looks for new items from the same point.
    expect(storeItemAfter()).toEqual(['$createdAt', '>', 500])

    // Short again, and now the full read answers: its new items' reviews are read.
    answer({
      storeItem: Array.from({ length: 100 }, (_, i) => doc(`New${i}`, SELLER, 9_000 - i, { title: `New ${i}` })),
      itemReview: [doc('IRevX', BUYER, 9_500, { storeId: STORE, itemId: NEW_ITEM, rating: 4 })],
    })
    getAllByStore.mockResolvedValueOnce([{ id: ITEM, title: 'Blue mug', createdAt: new Date(500) }, { id: NEW_ITEM, title: 'Red mug', createdAt: new Date(8_000) }])
    const events = await stores.getNotifications(SELLER, 5_000, vi.fn())
    expect(events.map((event) => [event.id, event.store.itemTitle])).toEqual([['itemReview-IRevX', 'Red mug']])
    answer({})
    await stores.getNotifications(SELLER, 9_500, vi.fn())
    expect(storeItemAfter()).toEqual(['$createdAt', '>', 8_000])
  })

  it('follows a store a moderator removed to its replacement, read from the replacement\'s creation', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    try {
      getByOwner.mockResolvedValue(sellerStore)
      const stores = await service()
      await stores.getNotifications(SELLER, SINCE, vi.fn())
      const REPLACEMENT = NEW_ITEM
      getByOwner.mockResolvedValue({ id: REPLACEMENT, createdAt: new Date(4_000) })
      answer({ storeOrder: [doc('OrdB', BUYER, 4_500, { storeId: REPLACEMENT })] })
      // Within the re-check interval the cached store is still read.
      await stores.getNotifications(SELLER, 6_000, vi.fn())
      expect(getByOwner).toHaveBeenCalledTimes(1)

      vi.setSystemTime(1_000_000 + 5 * 60 * 1000)
      bundle.mockClear()
      const events = await stores.getNotifications(SELLER, 6_000, vi.fn())

      expect(bundled(0).find((query) => query.documentTypeName === 'storeOrder')?.where).toEqual([['storeId', '==', REPLACEMENT], ['$createdAt', '>', 3_999]])
      expect(events.map((event) => event.id)).toEqual(['storeOrder-OrdB'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits a store with more than 100 items into `in` reads of 100', async () => {
    getAllByStore.mockResolvedValue(Array.from({ length: 150 }, (_, i) => ({ id: `item${i}`, title: `Item ${i}`, createdAt: new Date(i) })))
    getByOwner.mockResolvedValue(sellerStore)
    const stores = await service()

    await stores.getNotifications(SELLER, SINCE, vi.fn())

    const inReads = bundled(0).filter((query) => query.documentTypeName === 'itemReview')
    expect(inReads.map((query) => (query.where?.[0][2] as string[]).length)).toEqual([100, 50])
  })

  it('reads on past a full first page, from its last row', async () => {
    const page = Array.from({ length: 100 }, (_, i) => doc(`Upd${i}`, SELLER, 10_000 - i, { status: 'shipped' }))
    answer({ orderStatusUpdate: page })
    paginateFetchAll.mockResolvedValue({ documents: [doc('UpdMore', SELLER, 1_500, { status: 'delivered' })], reachedLimit: false })
    const stores = await service()

    const events = await stores.getNotifications(BUYER, SINCE, vi.fn())

    expect(events).toHaveLength(101)
    const [, builder, , options] = paginateFetchAll.mock.calls[0] as [unknown, (startAfter?: string) => QueryDocumentsOptions, unknown, { maxResults: number; inClause?: boolean }]
    expect(builder().startAfter).toBe('Upd99')
    expect(builder('Later').startAfter).toBe('Later')
    expect(options).toEqual({ maxResults: 900, inClause: false })
  })

  it('reads an `in` read on to its end, uncapped: it walks item by item, so a cap would cut by item, not by age', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    answer({ itemReview: Array.from({ length: 100 }, (_, i) => doc(`IRev${i}`, BUYER, 9_000 - i, { itemId: ITEM, rating: 5 })) })
    paginateFetchAll.mockResolvedValue({ documents: [], reachedLimit: false })
    const stores = await service()

    await stores.getNotifications(SELLER, SINCE, vi.fn())

    expect(paginateFetchAll.mock.calls[0][3]).toEqual({ maxResults: Infinity, inClause: true })
  })

  it('reports a failed read and still answers from the sources that read', async () => {
    getByOwner.mockResolvedValue(sellerStore)
    answer({
      storeOrder: [doc('Ord1', BUYER, 2_000, { storeId: STORE })],
    })
    getAllByStore.mockRejectedValue(new Error('quorum'))
    const onFailure = vi.fn()
    const stores = await service()

    const events = await stores.getNotifications(SELLER, SINCE, onFailure)

    expect(onFailure).toHaveBeenCalledWith(new Error('quorum'))
    // Without the items there is nothing to read item reviews by; orders and store reviews still are.
    expect(shapes(bundled(0)).map(([type]) => type)).toEqual(['orderStatusUpdate', 'storeOrder', 'storeReview'])
    expect(events.map((event) => event.id)).toEqual(['storeOrder-Ord1'])
  })
})
