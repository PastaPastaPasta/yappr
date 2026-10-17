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
    const where = query.where ?? []
    if (query.documentTypeName === 'itemReview') {
      const ids = where[0][2] as string[]
      return (rows.itemReview ?? []).filter((row) => ids.includes(row.itemId as string))
    }
    return rows[query.documentTypeName] ?? []
  }))
}

async function service() {
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v9')
  vi.resetModules()
  return (await import('./store-notification-service')).storeNotificationService
}

beforeEach(() => {
  bundle.mockReset()
  getByOwner.mockReset().mockResolvedValue(null)
  getAllByStore.mockReset().mockResolvedValue([])
  paginateFetchAll.mockReset()
  answer({})
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('store notifications', () => {
  it('tells a buyer about status changes off buyerFeed, newest first, with the seller as the actor', async () => {
    answer({
      orderStatusUpdate: [
        doc('Upd1', SELLER, 5_000, { orderId: 'Order1', status: 'shipped', message: '  On its way!  ', trackingNumber: '1Z' }),
        doc('Upd2', SELLER, 4_000, { orderId: 'Order1', status: 'payment_received' }),
        doc('Upd3', SELLER, 3_000, { orderId: 'Order1', status: 'teleported' }),
      ],
    })
    const stores = await service()

    const events = await stores.getNotifications(BUYER, SINCE, vi.fn())

    const [queries] = bundle.mock.calls[0] as [QueryDocumentsOptions[]]
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({
      documentTypeName: 'orderStatusUpdate',
      where: [['orderId.$ownerId', '==', BUYER], ['$createdAt', '>', SINCE]],
      orderBy: [['orderId.$ownerId', 'asc'], ['$createdAt', 'desc']],
    })
    // An unknown status is not announced; the tracking number is not carried.
    expect(events).toEqual([
      { id: 'orderStatus-Upd1', type: 'orderStatus', fromUserId: SELLER, createdAt: 5_000, store: { status: 'shipped', text: 'On its way!' } },
      { id: 'orderStatus-Upd2', type: 'orderStatus', fromUserId: SELLER, createdAt: 4_000, store: { status: 'payment_received' } },
    ])
  })

  it('tells a seller about orders and reviews on their store, without any of the order\'s encrypted contents', async () => {
    getByOwner.mockResolvedValue({ id: STORE })
    getAllByStore.mockResolvedValue([{ id: ITEM, title: 'Blue mug' }])
    answer({
      storeOrder: [doc('Ord1', BUYER, 2_000, { storeId: STORE, sellerId: SELLER, encryptedPayload: [1, 2, 3], nonce: [4] })],
      storeReview: [doc('Rev1', BUYER, 3_000, { storeId: STORE, rating: 4, title: 'Great', content: 'Fast shipping' })],
      itemReview: [doc('IRev1', BUYER, 4_000, { storeId: STORE, itemId: ITEM, rating: 5, content: 'Love it' })],
    })
    const stores = await service()

    const events = await stores.getNotifications(SELLER, SINCE, vi.fn())

    const [queries] = bundle.mock.calls[0] as [QueryDocumentsOptions[]]
    expect(queries.map((query) => [query.documentTypeName, query.where?.[0]])).toEqual([
      ['orderStatusUpdate', ['orderId.$ownerId', '==', SELLER]],
      ['storeOrder', ['storeId', '==', STORE]],
      ['storeReview', ['storeId', '==', STORE]],
      ['itemReview', ['itemId', 'in', [ITEM]]],
    ])
    expect(queries.every((query) => query.orderBy?.[1]?.[1] === 'desc')).toBe(true)
    expect(events).toEqual([
      { id: 'storeOrder-Ord1', type: 'storeOrder', fromUserId: BUYER, createdAt: 2_000, store: { storeId: STORE } },
      { id: 'storeReview-Rev1', type: 'storeReview', fromUserId: BUYER, createdAt: 3_000, store: { storeId: STORE, rating: 4, text: 'Great — Fast shipping' } },
      { id: 'itemReview-IRev1', type: 'itemReview', fromUserId: BUYER, createdAt: 4_000, store: { storeId: STORE, rating: 5, text: 'Love it', itemId: ITEM, itemTitle: 'Blue mug' } },
    ])
  })

  it('looks a found store up once, and a missing one again every poll', async () => {
    const stores = await service()
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    getByOwner.mockResolvedValue({ id: STORE })
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    await stores.getNotifications(SELLER, SINCE, vi.fn())
    expect(getByOwner).toHaveBeenCalledTimes(2)
    // The item titles are held between polls too.
    expect(getAllByStore).toHaveBeenCalledTimes(1)
  })

  it('reads the items again when an order newer than the last item read arrives, and the reviews of the new ones', async () => {
    getByOwner.mockResolvedValue({ id: STORE })
    getAllByStore.mockResolvedValueOnce([{ id: ITEM, title: 'Blue mug' }])
      .mockResolvedValueOnce([{ id: ITEM, title: 'Blue mug' }, { id: NEW_ITEM, title: 'Red mug' }])
    answer({
      storeOrder: [doc('Ord2', BUYER, Date.now(), { storeId: STORE })],
      itemReview: [doc('IRev2', BUYER, Date.now(), { storeId: STORE, itemId: NEW_ITEM, rating: 3 })],
    })
    const stores = await service()

    const events = await stores.getNotifications(SELLER, SINCE, vi.fn())

    expect(getAllByStore).toHaveBeenCalledTimes(2)
    const [followUp] = bundle.mock.calls[1] as [QueryDocumentsOptions[]]
    expect(followUp.map((query) => query.where?.[0])).toEqual([['itemId', 'in', [NEW_ITEM]]])
    expect(events.find((event) => event.type === 'itemReview')?.store).toEqual({ storeId: STORE, rating: 3, itemId: NEW_ITEM, itemTitle: 'Red mug' })
  })

  it('reads on past a full first page, from its last row', async () => {
    const page = Array.from({ length: 100 }, (_, i) => doc(`Upd${i}`, SELLER, 10_000 - i, { status: 'shipped' }))
    answer({ orderStatusUpdate: page })
    paginateFetchAll.mockResolvedValue({ documents: [doc('UpdMore', SELLER, 1_500, { status: 'delivered' })], reachedLimit: false })
    const stores = await service()

    const events = await stores.getNotifications(BUYER, SINCE, vi.fn())

    expect(events).toHaveLength(101)
    const builder = paginateFetchAll.mock.calls[0][1] as (startAfter?: string) => QueryDocumentsOptions
    expect(builder().startAfter).toBe('Upd99')
    expect(builder('Later').startAfter).toBe('Later')
  })

  it('reports a failed read and still answers from the sources that read', async () => {
    getByOwner.mockRejectedValue(new Error('quorum'))
    answer({ orderStatusUpdate: [doc('Upd1', SELLER, 5_000, { status: 'delivered' })] })
    const onFailure = vi.fn()
    const stores = await service()

    const events = await stores.getNotifications(SELLER, SINCE, onFailure)

    expect(onFailure).toHaveBeenCalledWith(new Error('quorum'))
    expect(events.map((event) => event.id)).toEqual(['orderStatus-Upd1'])
  })
})
