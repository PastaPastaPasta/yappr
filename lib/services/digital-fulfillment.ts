import { logger } from '@/lib/logger';
/**
 * Fulfil a digital order: take the license keys it uses out of each kit's
 * pool, publish the encrypted delivery, and optionally mark the order
 * delivered.
 *
 * The pools are saved FIRST, each at the revision it was read
 * (`saveKit`), so a key is never handed out twice: a stale pool (another tab
 * delivered meanwhile) refuses the write and nothing is sent. If the delivery
 * then fails, the pools are put back; should that fail too, the seller is told
 * which keys to re-add (a lost key is recoverable, a key sent twice is not).
 * A write whose response failed is reconciled against the chain before either
 * decision, since a broadcast can land after its response times out.
 */

import { itemDeliverableService, KitWriteUncertainError, type SellerKit } from './item-deliverable-service';
import { orderDeliveryService } from './order-delivery-service';
import { orderStatusService } from './order-status-service';
import { decodeDelivery, encodeDelivery, kitsAfterDelivery } from './digital-delivery-plan';
import type { OrderDelivery, OrderDeliveryPayload, OrderStatusUpdate, StoreOrder } from '../../types';

export interface FulfillOrderInput {
  sellerId: string;
  order: StoreOrder;
  delivery: OrderDeliveryPayload;
  /** License keys the delivery took from each item's pool (from `planDelivery`). */
  consumedKeys: ReadonlyMap<string, number>;
  kits: ReadonlyMap<string, SellerKit>;
  markDelivered: boolean;
  sellerPrivateKey: Uint8Array;
}

export interface FulfillOrderResult {
  delivery: OrderDelivery;
  status?: OrderStatusUpdate;
  /** Kits whose pools this delivery drew on, keyed by item id; merge into the caller's kit map. */
  updatedKits: Map<string, SellerKit>;
  warnings: string[];
}

/** License keys the seller may need to put back in a product's pool by hand. */
export interface KeyRecoveryEntry {
  itemTitle: string;
  keys: string[];
}

/**
 * A fulfilment failure that leaves license keys for the seller to restore by
 * hand. The keys are plaintext from the seller's encrypted kit, so they are
 * NOT in `message` (which is logged): they sit in a private field and reach
 * the seller only through {@link KeyRecoveryError.recoveryText}, shown in the
 * UI. Log this error by its message, never the object.
 */
export class KeyRecoveryError extends Error {
  readonly #entries: KeyRecoveryEntry[];

  constructor(message: string, entries: KeyRecoveryEntry[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyRecoveryError';
    this.#entries = entries;
  }

  /** Seller-facing recovery instructions, keys included. Show it; never log it. */
  recoveryText(): string {
    const lines = this.#entries.map((entry) => `"${entry.itemTitle}": ${entry.keys.join(', ')}`);
    return `${this.message} Check these products' pools and re-add any of these keys not already there: ${lines.join('; ')}.`;
  }
}

/** What to log for a fulfilment failure: never the key-bearing recovery details. */
export const loggableFulfillmentError = (error: unknown): unknown =>
  error instanceof KeyRecoveryError ? `${error.name}: ${error.message}` : error;

/** What to show the seller for a fulfilment failure. */
export const fulfillmentErrorText = (error: unknown): string =>
  error instanceof KeyRecoveryError ? error.recoveryText() : error instanceof Error ? error.message : 'Delivery failed. Please try again.';

export const toKitPayloads = (kits: ReadonlyMap<string, SellerKit>) =>
  new Map([...kits].map(([itemId, { kit }]) => [itemId, kit]));

/** Block time vs. this device's clock, for telling this attempt's delivery from earlier ones. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const titleOf = (delivery: OrderDeliveryPayload, itemId: string) =>
  delivery.items.find((item) => item.itemId === itemId)?.itemTitle ?? itemId;

/** The keys this delivery takes from one item's pool. */
const keysTaken = (input: FulfillOrderInput, itemId: string): KeyRecoveryEntry => ({
  itemTitle: titleOf(input.delivery, itemId),
  keys: input.kits.get(itemId)?.kit.licenseKeys?.slice(0, input.consumedKeys.get(itemId) ?? 0) ?? [],
});

/**
 * Put the pools a failed delivery drew on back as they were, at their new
 * revisions. Returns the pools it could not restore (or could not confirm).
 */
async function restorePools(
  input: FulfillOrderInput,
  drawn: ReadonlyMap<string, SellerKit>
): Promise<KeyRecoveryEntry[]> {
  const unrestored: KeyRecoveryEntry[] = [];
  for (const [itemId, after] of drawn) {
    const before = input.kits.get(itemId);
    if (!before) continue;
    try {
      await itemDeliverableService.saveKit(input.sellerId, itemId, before.kit, input.sellerPrivateKey, after.deliverable);
    } catch (error) {
      logger.error(`Could not restore the license-key pool for item ${itemId}:`, error);
      unrestored.push(keysTaken(input, itemId));
    }
  }
  return unrestored;
}

/**
 * After the delivery write reported failure: is it on chain anyway (a
 * broadcast can land after its response times out)? The delivery when it is,
 * `absent` when the order's deliveries were read and it is not among them,
 * `unknown` when they could not be read.
 */
async function reconcileDelivery(input: FulfillOrderInput, startedAt: number): Promise<OrderDelivery | 'absent' | 'unknown'> {
  try {
    // Compare in decoded form (the decoder fixes key order), and only against
    // deliveries from this attempt, not an identical earlier send.
    const expected = JSON.stringify(decodeDelivery(encodeDelivery(input.delivery)));
    const deliveries = await orderDeliveryService.loadDecrypted([input.order], (delivery, order) =>
      orderDeliveryService.decryptAsSeller(delivery, order, input.sellerPrivateKey));
    const match = deliveries.get(input.order.id)?.find((delivery) =>
      delivery.createdAt.getTime() >= startedAt - CLOCK_SKEW_MS && JSON.stringify(delivery.payload) === expected);
    return match ?? 'absent';
  } catch (error) {
    logger.warn('Could not check whether the failed delivery landed:', error);
    return 'unknown';
  }
}

export async function fulfillOrder(input: FulfillOrderInput): Promise<FulfillOrderResult> {
  const { sellerId, order, sellerPrivateKey } = input;

  // 1. Take the keys out of the pools. A failure here sends nothing.
  const updatedKits = new Map<string, SellerKit>();
  for (const [itemId, kit] of kitsAfterDelivery(toKitPayloads(input.kits), input.consumedKeys)) {
    // kitsAfterDelivery only answers items present in input.kits.
    const previous = input.kits.get(itemId)?.deliverable ?? null;
    try {
      const deliverable = await itemDeliverableService.saveKit(sellerId, itemId, kit, sellerPrivateKey, previous);
      updatedKits.set(itemId, { deliverable, kit });
    } catch (error) {
      const recovery = await restorePools(input, updatedKits);
      // This pool's own write may have landed unseen: its keys may be gone too.
      if (error instanceof KitWriteUncertainError) recovery.push(keysTaken(input, itemId));
      const message = `Nothing was delivered: the license keys for "${titleOf(input.delivery, itemId)}" could not be reserved (${error instanceof Error ? error.message : 'unknown error'}).`;
      if (recovery.length > 0) throw new KeyRecoveryError(message, recovery, { cause: error });
      throw new Error(message, { cause: error });
    }
  }

  // 2. Deliver. On a definite failure, give the reserved keys back.
  let delivery: OrderDelivery;
  const startedAt = Date.now();
  try {
    delivery = await orderDeliveryService.deliver(sellerId, order, input.delivery, sellerPrivateKey);
  } catch (error) {
    const outcome = await reconcileDelivery(input, startedAt);
    if (typeof outcome === 'object') {
      delivery = { ...outcome, payload: input.delivery };
    } else if (outcome === 'unknown') {
      // Restoring keys a landed delivery has sent would hand them out twice;
      // keeping them out of the pool only risks keys the seller can re-add.
      const reserved = [...updatedKits.keys()].map((itemId) => keysTaken(input, itemId));
      const message = 'Could not confirm whether the delivery was sent. Check the order before delivering again.';
      if (reserved.length > 0) throw new KeyRecoveryError(`${message} If it was not sent, its license keys are out of their pools.`, reserved, { cause: error });
      throw new Error(message, { cause: error });
    } else {
      const unrestored = await restorePools(input, updatedKits);
      if (unrestored.length > 0) {
        throw new KeyRecoveryError('Delivery failed, and its license keys could not be put back.', unrestored, { cause: error });
      }
      throw error;
    }
  }

  const warnings: string[] = [];

  let status: OrderStatusUpdate | undefined;
  if (input.markDelivered) {
    try {
      status = await orderStatusService.createStatusUpdate(sellerId, order.id, { status: 'delivered', buyerId: order.buyerId });
    } catch (error) {
      logger.error('Delivered, but could not mark the order delivered:', error);
      warnings.push('The goods were delivered, but the order status could not be updated. Set it to Delivered manually.');
    }
  }

  return { delivery, status, updatedKits, warnings };
}
