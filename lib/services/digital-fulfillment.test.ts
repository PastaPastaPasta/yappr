import { beforeEach, describe, expect, it, vi } from 'vitest'

const { saveKit, deliver, loadDecrypted, createStatusUpdate, KitWriteUncertainError } = vi.hoisted(() => ({
  saveKit: vi.fn(),
  deliver: vi.fn(),
  loadDecrypted: vi.fn(),
  createStatusUpdate: vi.fn(),
  KitWriteUncertainError: class extends Error {},
}))
vi.mock('./item-deliverable-service', () => ({ itemDeliverableService: { saveKit }, KitWriteUncertainError }))
vi.mock('./order-delivery-service', () => ({ orderDeliveryService: { deliver, loadDecrypted, decryptAsSeller: vi.fn() } }))
vi.mock('./order-status-service', () => ({ orderStatusService: { createStatusUpdate } }))
import { fulfillOrder, fulfillmentErrorText, KeyRecoveryError, loggableFulfillmentError, type FulfillOrderInput } from './digital-fulfillment'
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
  loadDecrypted.mockReset()
  createStatusUpdate.mockReset()
  // By default the chain shows no delivery landed.
  loadDecrypted.mockResolvedValue(new Map())
})

/** The recovery error a call rejected with. */
async function recoveryErrorOf(promise: Promise<unknown>): Promise<KeyRecoveryError> {
  const error = await promise.then(() => null, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(KeyRecoveryError)
  return error as KeyRecoveryError
}

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
    await expect(fulfillOrder(input())).rejects.not.toBeInstanceOf(KeyRecoveryError)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('asks the seller to check the pool when its reservation may have landed unseen', async () => {
    saveKit.mockRejectedValue(new KitWriteUncertainError('unclear'))
    const error = await recoveryErrorOf(fulfillOrder(input()))
    expect(error.recoveryText()).toMatch(/"Game": k1/)
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

  it('names the keys to re-add when they cannot be put back, outside anything that is logged', async () => {
    saveKit.mockResolvedValueOnce({ ...deliverable, $revision: 5 }).mockRejectedValueOnce(new Error('offline'))
    deliver.mockRejectedValue(new Error('broadcast failed'))
    const error = await recoveryErrorOf(fulfillOrder(input()))
    expect(error.recoveryText()).toMatch(/"Game": k1/)
    expect(fulfillmentErrorText(error)).toMatch(/"Game": k1/)
    // The message, the logged form and the serialized object never carry a key.
    expect(error.message).not.toMatch(/k1/)
    expect(String(loggableFulfillmentError(error))).not.toMatch(/k1/)
    expect(JSON.stringify(error)).not.toMatch(/k1/)
    expect(Object.values(error).join(' ')).not.toMatch(/k1/)
  })

  it('treats a delivery that landed despite a failed response as delivered', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    deliver.mockRejectedValue(new Error('504'))
    loadDecrypted.mockResolvedValue(new Map([[order.id, [
      { id: 'landed', createdAt: new Date(), payload: input().delivery },
    ]]]))
    createStatusUpdate.mockResolvedValue({ status: 'delivered' })
    const result = await fulfillOrder(input())
    expect(result.delivery.id).toBe('landed')
    expect(saveKit).toHaveBeenCalledTimes(1)
  })

  it('does not ignore an identical delivery from an earlier send', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    deliver.mockRejectedValue(new Error('broadcast failed'))
    loadDecrypted.mockResolvedValue(new Map([[order.id, [
      { id: 'old', createdAt: new Date(Date.now() - 24 * 3600_000), payload: input().delivery },
    ]]]))
    await expect(fulfillOrder(input())).rejects.toThrow('broadcast failed')
    expect(saveKit).toHaveBeenCalledTimes(2)
  })

  it('keeps reserved keys out of the pool when it cannot tell whether the delivery landed', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    deliver.mockRejectedValue(new Error('504'))
    loadDecrypted.mockRejectedValue(new Error('offline'))
    const error = await recoveryErrorOf(fulfillOrder(input()))
    expect(error.message).toMatch(/Could not confirm/)
    // Restoring could hand the keys out twice; only the reservation was written.
    expect(saveKit).toHaveBeenCalledTimes(1)
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
