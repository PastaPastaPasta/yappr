import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateOutcome } from '@/lib/services/create-outcome'
import type { CreateReceipt } from '@/lib/services/state-transition-service'
import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID } from '@/lib/constants'
import {
  ORDER_CART_CHANGED_MESSAGE,
  ORDER_NOT_KEPT_MESSAGE,
  ORDER_STILL_CONFIRMING_MESSAGE,
  loadPendingCheckoutOrder,
  sendCheckoutOrder,
  sendRefusal,
  settlementOf,
  type OrderSendOptions,
  type OrderSettlement,
  type ReplacingOrder,
} from './pending-checkout-order'
import type { OrderPaymentStatus } from './checkout-payment'

// The record lives in localStorage; an in-memory one here (writes can be made to fail).
const storage = new Map<string, string>()
let writesFail = false
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (writesFail) throw new Error('QuotaExceededError')
    storage.set(key, value)
  },
  removeItem: (key: string) => { storage.delete(key) },
})
vi.stubGlobal('window', {})

const BUYER = '33333333333333333333333333333333'
const STORE = 'store-1'
const RECORD_KEY = `yappr:checkout-pending-order:${BUYER}:${STORE}`
const PAID: OrderPaymentStatus = { kind: 'detected', amountDash: 0.5 }

let nextId = 0
const receiptAt = (nonce: number): CreateReceipt => ({
  contractId: YAPPR_STOREFRONT_CONTRACT_ID,
  documentType: STOREFRONT_DOCUMENT_TYPES.STORE_ORDER,
  ownerId: BUYER,
  documentId: `order-${++nextId}`,
  nonce: BigInt(nonce),
  transition: new Uint8Array([nonce, 1, 2, 3]),
})

/**
 * A create as `stateTransitionService.createDocument` runs it: the hook right
 * before the broadcast (a throw refuses it, nothing sent), then `outcome`.
 */
function fakeCreate(outcome: (receipt: CreateReceipt) => CreateOutcome<unknown>, nonce = 5) {
  const sent: CreateReceipt[] = []
  const create = vi.fn(async (options: OrderSendOptions): Promise<CreateOutcome<unknown>> => {
    const receipt = receiptAt(options.replacesNonce === undefined ? nonce : Number(options.replacesNonce))
    try {
      options.beforeBroadcast(receipt)
    } catch (error) {
      return { status: 'failed', error: (error as Error).message }
    }
    sent.push(receipt)
    return outcome(receipt)
  })
  return { create, sent }
}

const confirmed = (): CreateOutcome<unknown> => ({ status: 'confirmed', document: {} })
const pending = (receipt: CreateReceipt): CreateOutcome<unknown> => ({ status: 'pending', document: {}, receipt })
const failed = (): CreateOutcome<unknown> => ({ status: 'failed', error: 'refused (code=40127)' })

/** What the page passes: the stored cart still holds the lines (unless told otherwise), and the cart clearing, spied. */
let cartHolds = true
const clearCart = vi.fn()
const send = (create: ReturnType<typeof fakeCreate>['create'], replacing?: ReplacingOrder, txid?: string) =>
  sendCheckoutOrder({ buyerId: BUYER, storeId: STORE, payment: PAID, hasDigital: true, txid, replacing, cartHolds: () => cartHolds, clearCart, create })
const recordedIds = () => loadPendingCheckoutOrder(BUYER, STORE)?.orders.map((order) => order.receipt.documentId)

beforeEach(() => {
  storage.clear()
  writesFail = false
  cartHolds = true
  clearCart.mockReset()
})

describe('the checkout state helper', () => {
  it('settles a record from its receipts', () => {
    expect(settlementOf(['not-recorded', 'landed'])).toBe('placed')
    expect(settlementOf(['stalled', null])).toBe('confirming')
    expect(settlementOf(['not-recorded', 'not-recorded'])).toBe('not-placed')
    expect(settlementOf(['not-recorded', 'stalled'])).toBe('stalled')
  })

  it('refuses a new order while one is recorded, unless it replaces exactly what was checked', () => {
    const first = { receipt: receiptAt(4), payment: PAID, hasDigital: false }
    const record = { buyerId: BUYER, storeId: STORE, orders: [first] }
    const replacing = { nonce: BigInt(4), documentIds: [first.receipt.documentId] }
    expect(sendRefusal(null, undefined)).toBeNull()
    expect(sendRefusal(record, undefined)).toEqual({ kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE })
    expect(sendRefusal(record, replacing)).toBeNull()
    // Another window sent one since the check, or settled it.
    expect(sendRefusal({ ...record, orders: [first, { ...first, receipt: receiptAt(4) }] }, replacing)).toEqual({ kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE })
    expect(sendRefusal(null, replacing)).toEqual({ kind: 'none' })
  })
})

describe('sending an order', () => {
  it('confirmed: records it before the broadcast, then clears the cart and forgets it', async () => {
    let recordedAtBroadcast = false
    const { create } = fakeCreate((receipt) => {
      recordedAtBroadcast = recordedIds()?.[0] === receipt.documentId
      return confirmed()
    })
    expect(await send(create)).toEqual({ kind: 'placed', payment: PAID, hasDigital: true })
    expect(recordedAtBroadcast).toBe(true)
    expect(clearCart).toHaveBeenCalledTimes(1)
    expect(loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
  })

  it('pending: keeps the record and the cart, and sends no second order for the cart', async () => {
    const { create, sent } = fakeCreate(pending)
    expect(await send(create)).toEqual({ kind: 'confirming' })
    expect(clearCart).not.toHaveBeenCalled()
    expect(recordedIds()).toEqual([sent[0].documentId])

    // Placing it again (this window, or another one) sends nothing.
    const again = fakeCreate(confirmed)
    expect(await send(again.create)).toEqual({ kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE })
    expect(again.create).not.toHaveBeenCalled()
    expect(clearCart).not.toHaveBeenCalled()
  })

  it('refuses at the broadcast an order another window recorded after the early check', async () => {
    const other = receiptAt(5)
    const { create, sent } = fakeCreate(confirmed)
    create.mockImplementationOnce(async (options) => {
      // Another window records its order while this one builds and signs.
      storage.set(RECORD_KEY, JSON.stringify({
        orders: [{ receipt: { ...other, nonce: other.nonce.toString(), transition: 'BQECAw==' }, payment: PAID, hasDigital: false }],
      }))
      try {
        options.beforeBroadcast(receiptAt(6))
      } catch (error) {
        return { status: 'failed', error: (error as Error).message }
      }
      return confirmed()
    })
    expect(await send(create)).toEqual({ kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE })
    expect(sent).toHaveLength(0)
    expect(recordedIds()).toEqual([other.documentId])
  })

  it('refuses an order whose lines another window already placed (its stored cart no longer holds them)', async () => {
    cartHolds = false
    const { create, sent } = fakeCreate(confirmed)
    expect(await send(create)).toEqual({ kind: 'failed', error: ORDER_CART_CHANGED_MESSAGE })
    expect(sent).toHaveLength(0)
    expect(loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
  })

  it('failed: forgets the record and keeps the cart', async () => {
    const { create } = fakeCreate(failed)
    expect(await send(create)).toEqual({ kind: 'failed', error: 'refused (code=40127)' })
    expect(clearCart).not.toHaveBeenCalled()
    expect(loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
  })

  it('keeps the record when the create gives no answer at all after it was recorded', async () => {
    const { create } = fakeCreate(confirmed)
    create.mockImplementationOnce(async (options) => {
      options.beforeBroadcast(receiptAt(5))
      throw new Error('lost')
    })
    expect(await send(create)).toMatchObject({ kind: 'confirming' })
    expect(recordedIds()).toHaveLength(1)
    expect(clearCart).not.toHaveBeenCalled()
  })

  it('sends nothing when the record cannot be kept', async () => {
    writesFail = true
    const { create, sent } = fakeCreate(confirmed)
    expect(await send(create)).toEqual({ kind: 'failed', error: ORDER_NOT_KEPT_MESSAGE })
    expect(sent).toHaveLength(0)
  })
})

describe('after a reload', () => {
  /** Sends an order that stays pending, then starts over from storage alone, as a reload does. */
  const sendPendingThenReload = async () => {
    const { create, sent } = fakeCreate(pending, 12)
    await send(create, undefined, 'tx-1')
    vi.resetModules()
    const reloaded = await import('./pending-checkout-order')
    return { reloaded, sent: sent[0] }
  }

  it('restores the exact signed order and what the buyer is told about it', async () => {
    const { reloaded, sent } = await sendPendingThenReload()
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)?.orders).toEqual([{ receipt: sent, payment: PAID, hasDigital: true, txid: 'tx-1' }])
  })

  it('settles that order and clears the cart only once it landed', async () => {
    const { reloaded, sent } = await sendPendingThenReload()
    const settle = vi.fn(async (): Promise<OrderSettlement> => null)
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, settle, clearCart)).toEqual({ kind: 'confirming' })
    expect(settle).toHaveBeenCalledWith(sent)
    expect(clearCart).not.toHaveBeenCalled()
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)).not.toBeNull()

    settle.mockResolvedValue('landed')
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, settle, clearCart)).toEqual({ kind: 'placed', payment: PAID, hasDigital: true })
    expect(clearCart).toHaveBeenCalledTimes(1)
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
  })

  it('keeps waiting when the check itself fails', async () => {
    const { reloaded } = await sendPendingThenReload()
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, () => Promise.reject(new Error('offline')), clearCart)).toEqual({ kind: 'confirming' })
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)).not.toBeNull()
  })

  it('lets the cart be ordered again once the order is proved never recorded, with its payment id', async () => {
    const { reloaded } = await sendPendingThenReload()
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, async () => 'not-recorded', clearCart)).toEqual({ kind: 'not-placed', txid: 'tx-1' })
    expect(clearCart).not.toHaveBeenCalled()
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
    const { create } = fakeCreate(confirmed)
    expect(await reloaded.sendCheckoutOrder({ buyerId: BUYER, storeId: STORE, payment: PAID, hasDigital: false, cartHolds: () => true, clearCart, create })).toMatchObject({ kind: 'placed' })
  })

  it('replaces a stalled order at its nonce, and a failed replacement leaves the stalled one recorded', async () => {
    const { reloaded, sent } = await sendPendingThenReload()
    const check = await reloaded.checkPendingCheckoutOrder(BUYER, STORE, async () => 'stalled', clearCart)
    expect(check).toEqual({ kind: 'stalled', replacing: { nonce: BigInt(12), documentIds: [sent.documentId], txid: 'tx-1' } })
    if (check.kind !== 'stalled') return
    const resend = (create: ReturnType<typeof fakeCreate>['create']) =>
      reloaded.sendCheckoutOrder({ buyerId: BUYER, storeId: STORE, payment: PAID, hasDigital: false, replacing: check.replacing, cartHolds: () => true, clearCart, create })

    const refused = fakeCreate(failed)
    // Refused when sent: the stalled order stands, and can still be placed again.
    expect(await resend(refused.create)).toEqual({ kind: 'stalled', replacing: check.replacing, error: 'refused (code=40127)' })
    expect(refused.create.mock.calls[0][0].replacesNonce).toBe(BigInt(12))
    expect(reloaded.loadPendingCheckoutOrder(BUYER, STORE)?.orders.map((order) => order.receipt)).toEqual([sent])

    const replaced = fakeCreate(pending)
    expect(await resend(replaced.create)).toEqual({ kind: 'confirming' })
    // Both are kept, at one nonce: whichever lands is the order, and the buyer is told about that one.
    const kept = reloaded.loadPendingCheckoutOrder(BUYER, STORE)?.orders ?? []
    expect(kept.map((order) => order.receipt.documentId)).toEqual([sent.documentId, replaced.sent[0].documentId])
    expect(new Set(kept.map((order) => order.receipt.nonce))).toEqual(new Set([BigInt(12)]))
    const firstLands = async (receipt: CreateReceipt): Promise<OrderSettlement> => (receipt.documentId === sent.documentId ? 'landed' : 'not-recorded')
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, firstLands, clearCart)).toEqual({ kind: 'placed', payment: PAID, hasDigital: true })
  })

  it('a replacement after another window settled the stalled order sends nothing', async () => {
    const { reloaded, sent } = await sendPendingThenReload()
    const replacing = { nonce: BigInt(12), documentIds: [sent.documentId] }
    // Another window proved it landed: the cart and the record are gone.
    expect(await reloaded.checkPendingCheckoutOrder(BUYER, STORE, async () => 'landed', clearCart)).toMatchObject({ kind: 'placed' })
    const { create } = fakeCreate(confirmed)
    expect(await reloaded.sendCheckoutOrder({ buyerId: BUYER, storeId: STORE, payment: PAID, hasDigital: false, replacing, cartHolds: () => true, clearCart, create })).toEqual({ kind: 'none' })
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores a record of another identity or contract', async () => {
    const { sent } = await sendPendingThenReload()
    storage.set(RECORD_KEY, JSON.stringify({
      orders: [{ receipt: { ...sent, contractId: 'another-contract', nonce: '12', transition: 'AQID' }, payment: PAID, hasDigital: false }],
    }))
    expect(loadPendingCheckoutOrder(BUYER, STORE)).toBeNull()
  })
})
