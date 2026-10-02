import { beforeEach, describe, expect, it, vi } from 'vitest'

const { saveKit, deliver, createStatusUpdate } = vi.hoisted(() => ({
  saveKit: vi.fn(),
  deliver: vi.fn(),
  createStatusUpdate: vi.fn(),
}))
vi.mock('./item-deliverable-service', () => ({ itemDeliverableService: { saveKit } }))
vi.mock('./order-delivery-service', () => ({ orderDeliveryService: { deliver } }))
vi.mock('./order-status-service', () => ({ orderStatusService: { createStatusUpdate } }))
import { fulfillOrder, type FulfillOrderInput } from './digital-fulfillment'
import type { ItemDeliverablePayload, StoreOrder } from '../../types'

const order = { id: 'order-1', buyerId: 'buyer', sellerId: 'seller', storeId: 'store' } as StoreOrder
const kit: ItemDeliverablePayload = { v: 1, assets: [], deliverWhen: 'on_order', licenseKeys: ['k1', 'k2', 'k3'] }
const deliverable = { id: 'kit-doc', ownerId: 'seller', itemId: 'game', createdAt: new Date(0), $revision: 4, encryptedPayload: new Uint8Array() }

const input = (overrides: Partial<FulfillOrderInput> = {}): FulfillOrderInput => ({
  sellerId: 'seller',
  order,
  delivery: { v: 1, items: [{ itemId: 'game', itemTitle: 'Game', assets: [], licenseKeys: ['k1'] }] },
  consumedKeys: new Map([['game', 1]]),
  kits: new Map([['game', { deliverable, kit }]]),
  markDelivered: true,
  sellerPrivateKey: new Uint8Array(32),
  ...overrides,
})

beforeEach(() => {
  saveKit.mockReset()
  deliver.mockReset()
  createStatusUpdate.mockReset()
})

describe('fulfillOrder', () => {
  it('reserves the keys at the revision it read, THEN delivers, then marks the order', async () => {
    const calls: string[] = []
    saveKit.mockImplementation(async () => { calls.push('save'); return { ...deliverable, $revision: 5 } })
    deliver.mockImplementation(async () => { calls.push('deliver'); return { id: 'delivery' } })
    createStatusUpdate.mockImplementation(async () => { calls.push('status'); return { status: 'delivered' } })

    const result = await fulfillOrder(input())
    expect(calls).toEqual(['save', 'deliver', 'status'])
    expect(saveKit.mock.calls[0][2].licenseKeys).toEqual(['k2', 'k3'])
    expect(saveKit.mock.calls[0][4]).toBe(deliverable)
    expect(result.updatedKits.get('game')?.deliverable.$revision).toBe(5)
    expect(result.warnings).toEqual([])
  })

  it('sends nothing when the pool cannot be reserved (e.g. it changed elsewhere)', async () => {
    saveKit.mockRejectedValue(new Error('stale revision'))
    await expect(fulfillOrder(input())).rejects.toThrow(/Nothing was delivered/)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('puts the keys back when the delivery fails', async () => {
    const reserved = { ...deliverable, $revision: 5 }
    saveKit.mockResolvedValueOnce(reserved).mockResolvedValueOnce({ ...deliverable, $revision: 6 })
    deliver.mockRejectedValue(new Error('broadcast failed'))
    await expect(fulfillOrder(input())).rejects.toThrow('broadcast failed')
    expect(saveKit).toHaveBeenCalledTimes(2)
    expect(saveKit.mock.calls[1][2]).toBe(kit)
    expect(saveKit.mock.calls[1][4]).toBe(reserved)
  })

  it('names the keys to re-add when they cannot be put back', async () => {
    saveKit.mockResolvedValueOnce({ ...deliverable, $revision: 5 }).mockRejectedValueOnce(new Error('offline'))
    deliver.mockRejectedValue(new Error('broadcast failed'))
    await expect(fulfillOrder(input())).rejects.toThrow(/"Game": k1/)
  })

  it('keeps the delivery when only the status update fails', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    deliver.mockResolvedValue({ id: 'delivery' })
    createStatusUpdate.mockRejectedValue(new Error('timeout'))
    const result = await fulfillOrder(input())
    expect(result.delivery).toEqual({ id: 'delivery' })
    expect(result.warnings).toHaveLength(1)
  })
})
