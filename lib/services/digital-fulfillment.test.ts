import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { saveKit, publish, findSealed, createStatusUpdate, KitWriteUncertainError } = vi.hoisted(() => ({
  saveKit: vi.fn(),
  publish: vi.fn(),
  findSealed: vi.fn(),
  createStatusUpdate: vi.fn(),
  KitWriteUncertainError: class extends Error {},
}))
vi.mock('./item-deliverable-service', () => ({ itemDeliverableService: { saveKit }, KitWriteUncertainError }))
vi.mock('./order-delivery-service', () => ({
  orderDeliveryService: { seal: () => SEALED, publish, findSealed },
}))
vi.mock('./order-status-service', () => ({ orderStatusService: { createStatusUpdate } }))
import { fulfillOrder, fulfillmentErrorText, KeyRecoveryError, loggableFulfillmentError, type FulfillOrderInput } from './digital-fulfillment'
import type { ItemDeliverablePayload, StoreOrder } from '../../types'

const SEALED = { encryptedPayload: new Uint8Array([9]), nonce: new Uint8Array(24) }
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
  vi.useFakeTimers()
  saveKit.mockReset()
  publish.mockReset()
  findSealed.mockReset()
  createStatusUpdate.mockReset()
  findSealed.mockResolvedValue('absent')
})
afterEach(() => {
  vi.useRealTimers()
})

/** Run `fulfillOrder`, skipping its reconciliation waits. */
async function run(overrides: Partial<FulfillOrderInput> = {}) {
  const promise = fulfillOrder(input(overrides))
  promise.catch(() => undefined)
  await vi.runAllTimersAsync()
  return promise
}

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
    publish.mockImplementation(async () => { calls.push('deliver'); return { delivery: { id: 'delivery' }, confirmed: true } })
    createStatusUpdate.mockImplementation(async () => { calls.push('status'); return { status: 'delivered' } })

    const result = await run()
    expect(calls).toEqual(['save', 'deliver', 'status'])
    expect(saveKit.mock.calls[0][2].licenseKeys).toEqual(['k2', 'k3'])
    expect(saveKit.mock.calls[0][4]).toBe(deliverable)
    expect(result.pending).toBe(false)
    expect(result.updatedKits.get('game')?.deliverable.$revision).toBe(5)
    expect(result.warnings).toEqual([])
  })

  it('sends nothing when the pool cannot be reserved (e.g. it changed elsewhere)', async () => {
    saveKit.mockRejectedValue(new Error('stale revision'))
    const error = await run().then(() => null, (reason: unknown) => reason)
    expect(String(error)).toMatch(/Nothing was delivered/)
    expect(error).not.toBeInstanceOf(KeyRecoveryError)
    expect(publish).not.toHaveBeenCalled()
  })

  it('asks the seller to check the pool when its reservation may have landed unseen', async () => {
    saveKit.mockRejectedValue(new KitWriteUncertainError('unclear'))
    const error = await recoveryErrorOf(run())
    expect(error.recoveryText()).toMatch(/"Game": k1/)
    expect(publish).not.toHaveBeenCalled()
  })

  it('puts back the pools it already reserved when a later reservation fails', async () => {
    const twoKits = new Map([
      ['game', { deliverable, kit }],
      ['dlc', { deliverable: { ...deliverable, id: 'dlc-doc', itemId: 'dlc' }, kit }],
    ])
    const reserved = { ...deliverable, $revision: 5 }
    saveKit.mockResolvedValueOnce(reserved).mockRejectedValueOnce(new Error('stale revision')).mockResolvedValueOnce({ ...deliverable, $revision: 6 })
    await expect(run({ kits: twoKits, consumedKeys: new Map([['game', 1], ['dlc', 1]]) })).rejects.toThrow(/Nothing was delivered/)
    expect(saveKit).toHaveBeenCalledTimes(3)
    expect(saveKit.mock.calls[2][2]).toBe(kit)
    expect(saveKit.mock.calls[2][4]).toBe(reserved)
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps reserved keys out of the pool when the delivery fails unseen, outside anything that is logged', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    publish.mockRejectedValue(new Error('broadcast failed'))
    const error = await recoveryErrorOf(run())
    // Not seen is not proof it never lands: restoring could hand the keys out twice.
    expect(saveKit).toHaveBeenCalledTimes(1)
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
    publish.mockRejectedValue(new Error('504'))
    findSealed.mockResolvedValueOnce('absent').mockResolvedValueOnce({ id: 'landed', createdAt: new Date() })
    createStatusUpdate.mockResolvedValue({ status: 'delivered' })
    const result = await run()
    expect(result.delivery.id).toBe('landed')
    expect(result.pending).toBe(false)
    expect(findSealed.mock.calls[0][1]).toBe(SEALED)
  })

  it('keeps an unconfirmed broadcast pending: keys reserved, order not marked delivered', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    publish.mockResolvedValue({ delivery: { id: 'maybe' }, confirmed: false })
    const result = await run()
    expect(result.pending).toBe(true)
    expect(result.delivery.unconfirmed).toBe(true)
    expect(createStatusUpdate).not.toHaveBeenCalled()
    expect(saveKit).toHaveBeenCalledTimes(1)
    expect(result.warnings).toHaveLength(1)
  })

  it('confirms an unconfirmed broadcast it can find on chain', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    publish.mockResolvedValue({ delivery: { id: 'maybe' }, confirmed: false })
    findSealed.mockResolvedValue({ id: 'landed', createdAt: new Date() })
    createStatusUpdate.mockResolvedValue({ status: 'delivered' })
    const result = await run()
    expect(result.pending).toBe(false)
    expect(createStatusUpdate).toHaveBeenCalled()
  })

  it('keeps the delivery when only the status update fails', async () => {
    saveKit.mockResolvedValue({ ...deliverable, $revision: 5 })
    publish.mockResolvedValue({ delivery: { id: 'delivery' }, confirmed: true })
    createStatusUpdate.mockRejectedValue(new Error('timeout'))
    const result = await run()
    expect(result.delivery).toEqual({ id: 'delivery' })
    expect(result.warnings).toHaveLength(1)
  })
})
