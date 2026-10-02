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
 */

import { itemDeliverableService, type SellerKit } from './item-deliverable-service';
import { orderDeliveryService } from './order-delivery-service';
import { orderStatusService } from './order-status-service';
import { kitsAfterDelivery } from './digital-delivery-plan';
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
  /**
   * Kits whose pools this delivery drew on, keyed by item id; merge into the
   * caller's kit map. A pool whose save failed is still advanced here (on its
   * old document), so the caller never hands the same keys to the next order
   * and the next save of that kit writes the removal too.
   */
  updatedKits: Map<string, SellerKit>;
  warnings: string[];
}

export const toKitPayloads = (kits: ReadonlyMap<string, SellerKit>) =>
  new Map([...kits].map(([itemId, { kit }]) => [itemId, kit]));

const titleOf = (delivery: OrderDeliveryPayload, itemId: string) =>
  delivery.items.find((item) => item.itemId === itemId)?.itemTitle ?? itemId;

/** Put the pools a failed delivery drew on back as they were, at their new revisions. */
async function restorePools(
  input: FulfillOrderInput,
  drawn: ReadonlyMap<string, SellerKit>
): Promise<string[]> {
  const unrestored: string[] = [];
  for (const [itemId, after] of drawn) {
    const before = input.kits.get(itemId);
    if (!before) continue;
    try {
      await itemDeliverableService.saveKit(input.sellerId, itemId, before.kit, input.sellerPrivateKey, after.deliverable);
    } catch (error) {
      logger.error(`Could not restore the license-key pool for item ${itemId}:`, error);
      const taken = before.kit.licenseKeys?.slice(0, input.consumedKeys.get(itemId) ?? 0) ?? [];
      unrestored.push(`"${titleOf(input.delivery, itemId)}": ${taken.join(', ')}`);
    }
  }
  return unrestored;
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
      const unrestored = await restorePools(input, updatedKits);
      throw new Error(
        `Nothing was delivered: the license keys for "${titleOf(input.delivery, itemId)}" could not be reserved (${error instanceof Error ? error.message : 'unknown error'}).` +
        (unrestored.length > 0 ? ` Re-add these keys to their products: ${unrestored.join('; ')}.` : ''),
        { cause: error }
      );
    }
  }

  // 2. Deliver. On failure, give the reserved keys back.
  let delivery: OrderDelivery;
  try {
    delivery = await orderDeliveryService.deliver(sellerId, order, input.delivery, sellerPrivateKey);
  } catch (error) {
    const unrestored = await restorePools(input, updatedKits);
    if (unrestored.length > 0) {
      throw new Error(`Delivery failed, and these license keys could not be put back. Re-add them to their products: ${unrestored.join('; ')}.`, { cause: error });
    }
    throw error;
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
