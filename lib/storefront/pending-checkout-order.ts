/**
 * An order checkout sent but could not confirm.
 *
 * A create whose outcome is unknown may still land, so checkout must neither
 * clear the cart (the order may be absent) nor let the buyer place it again
 * (both could land: two orders, maybe two payments). Before an order is
 * broadcast its signed transition is kept here, in localStorage (the cart is
 * there too), keyed by buyer and store. While the record stands:
 *
 * - no new order is sent for that cart, in any window: the check runs under
 *   the identity's write lock, right before the broadcast;
 * - "Check again" settles the very transition that went out
 *   (`stateTransitionService.settleCreate`: it re-sends the same bytes while
 *   their nonce is free, and calls it never recorded only on proof);
 * - the cart is cleared only once the order is confirmed or proved landed,
 *   and before the record goes, so a window that sees no record sees no cart
 *   either (every send checks the stored cart still holds what it orders).
 *
 * An order refused for now with its nonce still free (`stalled`) can be
 * placed again only AT THAT NONCE (`replacesNonce`), so at most one of the
 * two can ever land. Every order a record holds therefore shares one nonce.
 */
import { logger } from '@/lib/logger'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { readScoped, removeScoped, writeScoped } from '@/lib/storage-scope'
import { withIdentityWriteLock } from '@/lib/identity-write-lock'
import { STOREFRONT_DOCUMENT_TYPES, YAPPR_STOREFRONT_CONTRACT_ID } from '@/lib/constants'
import type { CreateOutcome } from '@/lib/services/create-outcome'
import type { CreateReceipt, CreateSettlement } from '@/lib/services/state-transition-service'
import type { OrderPaymentStatus } from './checkout-payment'

/** One order sent for the cart, and what the buyer is told if it is the one that lands. */
export interface SentOrder {
  receipt: CreateReceipt
  payment: OrderPaymentStatus
  /** Whether it has digital lines (the order-placed screen mentions the library). */
  hasDigital: boolean
  /** The payment transaction id it carries, offered again if it has to be placed again. */
  txid?: string
}

export interface PendingCheckoutOrder {
  buyerId: string
  storeId: string
  /** Every order sent for this cart that may still land (they share one nonce: at most one lands). */
  orders: SentOrder[]
}

/** A stalled order's nonce, every order sent for the cart when it was checked, and its payment id. */
export interface ReplacingOrder {
  nonce: bigint
  documentIds: string[]
  txid?: string
}

/** `settleCreate`'s answer for one receipt. */
export type OrderSettlement = CreateSettlement

export type CheckoutOrderResult =
  /** Confirmed, or proved landed: the cart is cleared; show the order placed. */
  | { kind: 'placed'; payment: OrderPaymentStatus; hasDigital: boolean }
  /** Sent, not confirmed yet: keep the cart, offer "Check again", send nothing new. */
  | { kind: 'confirming'; error?: string }
  /** Refused for now, its nonce still free: it may still land; placing it again replaces it. */
  | { kind: 'stalled'; replacing: ReplacingOrder; error?: string }
  /** Proved never recorded: the record is gone and the cart is kept, so it can be placed again. */
  | { kind: 'not-placed'; txid?: string }
  /** Refused or never sent: keep the cart and show why. */
  | { kind: 'failed'; error: string }
  /** The order this window knew of was settled in another window (or none was waiting). */
  | { kind: 'none' }

export const ORDER_STILL_CONFIRMING_MESSAGE = 'Your order for this cart is still being confirmed, so it wasn’t sent again. Check again in a moment.'
export const ORDER_CHECKED_ELSEWHERE_MESSAGE = 'Your earlier order was checked in another window. Look in My Orders before placing it again.'
export const ORDER_CART_CHANGED_MESSAGE = 'Your cart changed in another window, so this order wasn’t sent. Look in My Orders and review your cart before trying again.'
export const ORDER_NOT_KEPT_MESSAGE = 'This browser couldn’t keep a record of your order while it’s sent, so it wasn’t sent. Allow site storage or free up some space, then try again.'
export const ORDER_NOT_PLACED_MESSAGE = 'Your order didn’t reach the seller. Your cart is still here, so you can place it again. If you’ve already paid, don’t pay again: include your payment’s transaction ID.'
const ORDER_OUTCOME_UNKNOWN_MESSAGE = 'Your order may have gone out, but there was no answer. Check again in a moment.'

/**
 * Why an order may not be sent now, as the result to give instead, or null.
 * `replacing` is the stalled order a send replaces: allowed only while the
 * record holds no order beyond the ones seen when it was checked. Without it,
 * any record refuses. A record gone since that check was settled elsewhere.
 */
export function sendRefusal(stored: PendingCheckoutOrder | null, replacing: ReplacingOrder | undefined): CheckoutOrderResult | null {
  if (!replacing) return stored ? { kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE } : null
  if (!stored) return { kind: 'none' }
  const seen = new Set(replacing.documentIds)
  return stored.orders.every((order) => seen.has(order.receipt.documentId)) ? null : { kind: 'confirming', error: ORDER_STILL_CONFIRMING_MESSAGE }
}

/**
 * Where a record's orders stand, from their settlements: placed when any
 * landed, confirming while any is unknown, not placed when all were proved
 * never recorded, otherwise stalled (refused for now, may land later).
 */
export function settlementOf(outcomes: OrderSettlement[]): 'placed' | 'confirming' | 'not-placed' | 'stalled' {
  if (outcomes.includes('landed')) return 'placed'
  if (outcomes.includes(null)) return 'confirming'
  if (outcomes.every((outcome) => outcome === 'not-recorded')) return 'not-placed'
  return 'stalled'
}

// ---- the record ---------------------------------------------------------------

type StoredReceipt = Omit<CreateReceipt, 'nonce' | 'transition'> & { nonce: string; transition: string }
interface StoredPendingOrder {
  orders: (Omit<SentOrder, 'receipt'> & { receipt: StoredReceipt })[]
}

const recordKey = (buyerId: string, storeId: string) => `yappr:checkout-pending-order:${buyerId}:${storeId}`

/**
 * The order of `buyerId`'s cart at `storeId` still waiting to be confirmed, or
 * null. A record that does not parse, or names another identity, contract or
 * document type (another deployment's), is not this checkout's to settle.
 */
export function loadPendingCheckoutOrder(buyerId: string, storeId: string): PendingCheckoutOrder | null {
  const raw = readScoped(recordKey(buyerId, storeId))
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredPendingOrder
    const orders: SentOrder[] = stored.orders.map((order) => ({
      receipt: {
        contractId: order.receipt.contractId,
        documentType: order.receipt.documentType,
        ownerId: order.receipt.ownerId,
        documentId: order.receipt.documentId,
        nonce: BigInt(order.receipt.nonce),
        transition: base64ToBytes(order.receipt.transition),
      },
      payment: order.payment,
      hasDigital: order.hasDigital === true,
      ...(typeof order.txid === 'string' ? { txid: order.txid } : {}),
    }))
    const ours = orders.every(({ receipt, payment }) => receipt.ownerId === buyerId
      && receipt.contractId === YAPPR_STOREFRONT_CONTRACT_ID
      && receipt.documentType === STOREFRONT_DOCUMENT_TYPES.STORE_ORDER
      && typeof receipt.documentId === 'string'
      && typeof payment?.kind === 'string')
    if (ours) return { buyerId, storeId, orders }
    logger.warn('Checkout: a pending order record of another account or deployment was ignored')
  } catch (error) {
    logger.warn('Checkout: unreadable pending order record', error)
  }
  return null
}

function savePendingCheckoutOrder(record: PendingCheckoutOrder): boolean {
  const stored: StoredPendingOrder = {
    orders: record.orders.map((order) => ({
      ...order,
      receipt: { ...order.receipt, nonce: order.receipt.nonce.toString(), transition: bytesToBase64(order.receipt.transition) },
    })),
  }
  return writeScoped(recordKey(record.buyerId, record.storeId), JSON.stringify(stored))
}

function forgetPendingCheckoutOrder(buyerId: string, storeId: string): void {
  if (!removeScoped(recordKey(buyerId, storeId))) logger.warn('Checkout: could not remove the pending order record')
}

/** Under the identity's storefront write lock: every create, and every send it makes, holds it too. */
function underWriteLock<T>(buyerId: string, work: () => Promise<T>): Promise<T> {
  return withIdentityWriteLock(buyerId, YAPPR_STOREFRONT_CONTRACT_ID, work)
}

/** The order landed: the cart goes first, then the record (see the module comment). */
function placed(buyerId: string, storeId: string, order: Pick<SentOrder, 'payment' | 'hasDigital'>, clearCart: () => void): CheckoutOrderResult {
  clearCart()
  forgetPendingCheckoutOrder(buyerId, storeId)
  return { kind: 'placed', payment: order.payment, hasDigital: order.hasDigital }
}

// ---- sending and checking -----------------------------------------------------

/** What `storeOrderService.createOrder` takes to keep the record and, for a replacement, its nonce. */
export interface OrderSendOptions {
  beforeBroadcast: (receipt?: CreateReceipt) => void
  replacesNonce?: bigint
}

/**
 * Sends `buyerId`'s order for the cart at `storeId` through `create`,
 * keeping its record before it is broadcast. `replacing`: the stalled order
 * this one replaces (from {@link checkPendingCheckoutOrder}), signed at its
 * nonce. `cartHolds`: whether the stored cart still holds what this order
 * is for (another window may have placed it). `clearCart` runs once it is placed.
 */
export async function sendCheckoutOrder(input: {
  buyerId: string
  storeId: string
  payment: OrderPaymentStatus
  hasDigital: boolean
  txid?: string
  replacing?: ReplacingOrder
  cartHolds: () => boolean
  clearCart: () => void
  create: (options: OrderSendOptions) => Promise<CreateOutcome<unknown>>
}): Promise<CheckoutOrderResult> {
  const { buyerId, storeId, replacing } = input
  const order = { payment: input.payment, hasDigital: input.hasDigital, ...(input.txid ? { txid: input.txid } : {}) }
  // Checked again under the write lock right before the broadcast; this one only saves signing a refused order.
  const early = sendRefusal(loadPendingCheckoutOrder(buyerId, storeId), replacing)
  if (early) return early

  let sent: CreateReceipt | undefined
  let outcome: CreateOutcome<unknown>
  try {
    outcome = await input.create({
      ...(replacing ? { replacesNonce: replacing.nonce } : {}),
      // Runs under the write lock, after every read and build, before anything is sent. A throw sends nothing.
      beforeBroadcast: (receipt) => {
        const stored = loadPendingCheckoutOrder(buyerId, storeId)
        const refusal = sendRefusal(stored, replacing)
        if (refusal) throw new Error(refusal.kind === 'none' ? ORDER_CHECKED_ELSEWHERE_MESSAGE : ORDER_STILL_CONFIRMING_MESSAGE)
        if (!input.cartHolds()) throw new Error(ORDER_CART_CHANGED_MESSAGE)
        // Only a replay of cached bytes comes without a receipt, and a new order never has any.
        if (!receipt) throw new Error(ORDER_NOT_KEPT_MESSAGE)
        const orders = [...(stored?.orders ?? []).filter((kept) => kept.receipt.documentId !== receipt.documentId), { receipt, ...order }]
        if (!savePendingCheckoutOrder({ buyerId, storeId, orders })) throw new Error(ORDER_NOT_KEPT_MESSAGE)
        sent = receipt
      },
    })
  } catch (error) {
    // No verdict: once recorded it may have gone out, so it stays recorded and is checked like any other.
    logger.error('Checkout: the order create gave no answer', error)
    return sent ? { kind: 'confirming', error: ORDER_OUTCOME_UNKNOWN_MESSAGE } : { kind: 'failed', error: error instanceof Error ? error.message : 'Failed to create order' }
  }

  // Every order the record held shares this one's nonce, so none of them can land now.
  if (outcome.status === 'confirmed') return placed(buyerId, storeId, order, input.clearCart)
  if (outcome.status === 'pending') return { kind: 'confirming' }

  // A verdict, or nothing sent: this order never lands. Only its own entry goes: an earlier
  // stalled order it was to replace may still land.
  const earlier = await underWriteLock(buyerId, async () => {
    const stored = loadPendingCheckoutOrder(buyerId, storeId)
    if (!stored) return 'gone'
    const others = stored.orders.filter((kept) => kept.receipt.documentId !== sent?.documentId)
    if (others.length === 0) {
      forgetPendingCheckoutOrder(buyerId, storeId)
      return 'gone'
    }
    if (others.length !== stored.orders.length) savePendingCheckoutOrder({ ...stored, orders: others })
    return 'pending'
  })
  if (replacing) {
    // The stalled order this one was to replace was settled in another window meanwhile.
    if (earlier === 'gone') return { kind: 'none' }
    // The replacement was sent and refused: the stalled order is as it was, and can be placed again.
    // Not sent at all (another window sent one, or its nonce was spent meanwhile): check it first.
    if (sent) return { kind: 'stalled', replacing, error: outcome.error }
  }
  // An earlier order still recorded may land: nothing new goes out until it is checked.
  return earlier === 'pending' ? { kind: 'confirming', error: outcome.error } : { kind: 'failed', error: outcome.error }
}

/**
 * Settles the order waiting for `buyerId`'s cart at `storeId`, each receipt
 * through `settle` (`storeOrderService.settleOrder`). Landed, the cart is
 * cleared (`clearCart`) and the record goes. Every order it held proved never
 * recorded, the record goes unless another window sent one meanwhile.
 */
export async function checkPendingCheckoutOrder(
  buyerId: string,
  storeId: string,
  settle: (receipt: CreateReceipt) => Promise<OrderSettlement>,
  clearCart: () => void
): Promise<CheckoutOrderResult> {
  const stored = loadPendingCheckoutOrder(buyerId, storeId)
  if (!stored) return { kind: 'none' }
  const outcomes: OrderSettlement[] = []
  for (const { receipt } of stored.orders) {
    const outcome = await settle(receipt).catch((error: unknown) => {
      logger.warn(`Checkout: could not settle order ${receipt.documentId}`, error)
      return null
    })
    outcomes.push(outcome)
    if (outcome === 'landed') break
  }
  const latestTxid = [...stored.orders].reverse().find((order) => order.txid)?.txid

  switch (settlementOf(outcomes)) {
    case 'placed':
      return placed(buyerId, storeId, stored.orders[outcomes.indexOf('landed')], clearCart)
    case 'confirming':
      return { kind: 'confirming' }
    case 'stalled': {
      const nonce = stored.orders
        .filter((_, index) => outcomes[index] === 'stalled')
        .map((order) => order.receipt.nonce)
        .reduce((low, next) => (next < low ? next : low))
      return { kind: 'stalled', replacing: { nonce, documentIds: stored.orders.map((order) => order.receipt.documentId), ...(latestTxid ? { txid: latestTxid } : {}) } }
    }
    case 'not-placed': {
      const proved = new Set(stored.orders.map((order) => order.receipt.documentId))
      return underWriteLock(buyerId, async (): Promise<CheckoutOrderResult> => {
        const now = loadPendingCheckoutOrder(buyerId, storeId)
        if (!now) return { kind: 'none' }
        // Another window sent an order since: that one may still land.
        if (now.orders.some((order) => !proved.has(order.receipt.documentId))) return { kind: 'confirming' }
        forgetPendingCheckoutOrder(buyerId, storeId)
        return { kind: 'not-placed', ...(latestTxid ? { txid: latestTxid } : {}) }
      })
    }
  }
}
