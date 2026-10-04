import { logger } from '@/lib/logger';
/**
 * Fulfil a digital order: take the license keys it uses out of each kit's
 * pool, publish the encrypted delivery, and optionally mark the order
 * delivered.
 *
 * The delivery is sealed before anything is written, so a delivery that
 * cannot be built takes no keys. The pools are then saved BEFORE it is
 * published, each at the revision it was read (`saveKit`), so a key is never
 * handed out twice: a stale pool (another tab delivered meanwhile) refuses
 * the write and nothing is sent.
 *
 * Every write whose response failed is reconciled against the chain, since a
 * broadcast can land after its response times out. Once keys are reserved
 * they are only put back if the reservation itself was the step that failed;
 * a delivery that cannot be confirmed keeps them reserved and tells the seller
 * which keys to check. A lost key can be re-added; a key sent twice cannot be
 * recalled.
 */

import { itemDeliverableService, KitWriteUncertainError, type SellerKit } from './item-deliverable-service';
import { orderDeliveryService, type SealedDelivery } from './order-delivery-service';
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
  /**
   * The delivery was broadcast but not yet seen on chain. Its keys stay
   * reserved and the order is not marked delivered; it shows in the buyer's
   * library once it lands.
   */
  pending: boolean;
  status?: OrderStatusUpdate;
  /** Kits whose pools this delivery drew on, keyed by item id; merge into the caller's kit map. */
  updatedKits: Map<string, SellerKit>;
  warnings: string[];
  /**
   * For a pending delivery that holds unique codes: which codes are out of
   * their pools, so the seller can put them back if it never lands. Carries
   * plaintext codes: show it, never log it.
   */
  pendingRecoveryText?: string;
}

/** License keys the seller may need to put back in a product's pool by hand. */
export interface KeyRecoveryEntry {
  itemTitle: string;
  keys: string[];
}

const recoveryInstructions = (message: string, entries: readonly KeyRecoveryEntry[]) =>
  `${message} Check these products' unique codes and re-add any of these not already there: ${entries.map((entry) => `"${entry.itemTitle}": ${entry.keys.join(', ')}`).join('; ')}.`;

/**
 * A fulfilment that failed after writing some pools (the reservation, or a
 * restore of it). `updatedKits` holds those pools at their new revisions:
 * merge them like a result's, or the caller's copies are stale and every
 * later delivery from them is refused. The kits hold plaintext pools, so they
 * are kept off the object's own properties: log this error by its message.
 */
export class FulfillmentError extends Error {
  readonly #updatedKits: ReadonlyMap<string, SellerKit>;

  constructor(message: string, updatedKits: ReadonlyMap<string, SellerKit>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FulfillmentError';
    this.#updatedKits = updatedKits;
  }

  get updatedKits(): ReadonlyMap<string, SellerKit> {
    return this.#updatedKits;
  }
}

/**
 * A fulfilment failure that leaves license keys for the seller to restore by
 * hand. The keys are plaintext from the seller's encrypted kit, so they are
 * NOT in `message` (which is logged): they sit in a private field and reach
 * the seller only through {@link KeyRecoveryError.recoveryText}, shown in the
 * UI. Log this error by its message, never the object.
 */
export class KeyRecoveryError extends FulfillmentError {
  readonly #entries: KeyRecoveryEntry[];

  constructor(message: string, entries: KeyRecoveryEntry[], updatedKits: ReadonlyMap<string, SellerKit>, options?: { cause?: unknown }) {
    super(message, updatedKits, options);
    this.name = 'KeyRecoveryError';
    this.#entries = entries;
  }

  /** Seller-facing recovery instructions, keys included. Show it; never log it. */
  recoveryText(): string {
    return recoveryInstructions(this.message, this.#entries);
  }
}

/** What to log for a fulfilment failure: never the key-bearing recovery details or kits. */
export const loggableFulfillmentError = (error: unknown): unknown =>
  error instanceof FulfillmentError ? `${error.name}: ${error.message}` : error;

/** What to show the seller for a fulfilment failure. */
export const fulfillmentErrorText = (error: unknown): string =>
  error instanceof KeyRecoveryError ? error.recoveryText() : error instanceof Error ? error.message : 'Delivery failed. Please try again.';

export const toKitPayloads = (kits: ReadonlyMap<string, SellerKit>) =>
  new Map([...kits].map(([itemId, { kit }]) => [itemId, kit]));

/**
 * Kit copies merged: the incoming copy wins unless the held one is the SAME
 * document at a newer revision (a reservation this session made that a
 * lagging read has not caught up with). Revisions of different documents say
 * nothing about which is current: a kit deleted and created again starts over
 * at revision 1, so the incoming (just read or just written) document wins.
 */
export function newerKits(current: ReadonlyMap<string, SellerKit>, incoming: ReadonlyMap<string, SellerKit>): Map<string, SellerKit> {
  const merged = new Map(current);
  for (const [itemId, kit] of incoming) {
    const held = merged.get(itemId);
    const heldIsNewer = held !== undefined && held.deliverable.id === kit.deliverable.id &&
      (held.deliverable.$revision ?? 0) > (kit.deliverable.$revision ?? 0);
    if (!heldIsNewer) merged.set(itemId, kit);
  }
  return merged;
}

/**
 * The kit of each item for a delivery about to go out: the one just read,
 * unless this session holds the same document at a newer revision. Null when
 * an item has no kit in the fresh read (missing, unreadable, or not
 * decryptable here), so a stale copy can never stand in for it.
 */
export function kitsOf(itemIds: readonly string[], held: ReadonlyMap<string, SellerKit>, fresh: ReadonlyMap<string, SellerKit>): Map<string, SellerKit> | null {
  const kits = new Map<string, SellerKit>();
  for (const itemId of new Set(itemIds)) {
    const read = fresh.get(itemId);
    if (!read) return null;
    kits.set(itemId, newerKits(held, new Map([[itemId, read]])).get(itemId) ?? read);
  }
  return kits;
}


const titleOf = (delivery: OrderDeliveryPayload, itemId: string) =>
  delivery.items.find((item) => item.itemId === itemId)?.itemTitle ?? itemId;

/** The keys this delivery takes from one item's pool. */
const keysTaken = (input: FulfillOrderInput, itemId: string): KeyRecoveryEntry => ({
  itemTitle: titleOf(input.delivery, itemId),
  keys: input.kits.get(itemId)?.kit.licenseKeys?.slice(0, input.consumedKeys.get(itemId) ?? 0) ?? [],
});

/**
 * Put the pools a failed delivery drew on back as they were, at their new
 * revisions. Returns the pools it restored (at their new revisions) and the
 * ones it could not restore (or could not confirm).
 */
async function restorePools(
  input: FulfillOrderInput,
  drawn: ReadonlyMap<string, SellerKit>
): Promise<{ current: Map<string, SellerKit>; unrestored: KeyRecoveryEntry[] }> {
  const current = new Map<string, SellerKit>();
  const unrestored: KeyRecoveryEntry[] = [];
  for (const [itemId, after] of drawn) {
    const before = input.kits.get(itemId);
    if (!before) continue;
    try {
      const deliverable = await itemDeliverableService.saveKit(input.sellerId, itemId, before.kit, input.sellerPrivateKey, after.deliverable);
      current.set(itemId, { deliverable, kit: before.kit });
    } catch (error) {
      logger.error(`Could not restore the license-key pool for item ${itemId}:`, error);
      unrestored.push(keysTaken(input, itemId));
    }
  }
  return { current, unrestored };
}

/** Reads after an unconfirmed delivery: a node may lag the one that took it. */
const DELIVERY_RECONCILE_ATTEMPTS = 3;
const DELIVERY_RECONCILE_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Look for this attempt's delivery on chain, a few times over. */
async function findDelivery(orderId: string, sealed: SealedDelivery): Promise<OrderDelivery | 'absent' | 'unknown'> {
  let outcome: OrderDelivery | 'absent' | 'unknown' = 'unknown';
  for (let attempt = 0; attempt < DELIVERY_RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(DELIVERY_RECONCILE_DELAY_MS);
    outcome = await orderDeliveryService.findSealed(orderId, sealed);
    if (typeof outcome === 'object') return outcome;
  }
  return outcome;
}

export async function fulfillOrder(input: FulfillOrderInput): Promise<FulfillOrderResult> {
  const { sellerId, order, sellerPrivateKey } = input;

  // 1. Seal first: everything that can fail without a write (size, key
  // derivation) fails here, before a single key leaves its pool. Sealed once,
  // so this attempt is recognisable on chain by its nonce.
  const sealed = orderDeliveryService.seal(order, input.delivery, sellerPrivateKey);

  // 2. Take the keys out of the pools. A failure here sends nothing.
  const updatedKits = new Map<string, SellerKit>();
  for (const [itemId, kit] of kitsAfterDelivery(toKitPayloads(input.kits), input.consumedKeys)) {
    // kitsAfterDelivery only answers items present in input.kits.
    const previous = input.kits.get(itemId)?.deliverable ?? null;
    try {
      const deliverable = await itemDeliverableService.saveKit(sellerId, itemId, kit, sellerPrivateKey, previous);
      updatedKits.set(itemId, { deliverable, kit });
    } catch (error) {
      const { current, unrestored: recovery } = await restorePools(input, updatedKits);
      // This pool's own write may have landed unseen: its keys may be gone too.
      if (error instanceof KitWriteUncertainError) recovery.push(keysTaken(input, itemId));
      const message = `Nothing was delivered: the unique codes for "${titleOf(input.delivery, itemId)}" could not be reserved (${error instanceof Error ? error.message : 'unknown error'}).`;
      if (recovery.length > 0) throw new KeyRecoveryError(message, recovery, current, { cause: error });
      throw new FulfillmentError(message, current, { cause: error });
    }
  }

  // 3. Deliver.
  const reserved = () => [...updatedKits.keys()].map((itemId) => keysTaken(input, itemId));
  let delivery: OrderDelivery;
  let pending = false;
  try {
    const published = await orderDeliveryService.publish(sellerId, order, sealed, input.delivery);
    delivery = published.delivery;
    if (!published.confirmed) {
      const found = await findDelivery(order.id, sealed);
      if (typeof found === 'object') delivery = { ...found, payload: input.delivery };
      else pending = true;
    }
  } catch (error) {
    const found = await findDelivery(order.id, sealed);
    if (typeof found !== 'object') {
      // Not seen on chain, which does not prove it never will be: keep the keys reserved.
      const message = 'The delivery could not be confirmed. Check the order before delivering again.';
      const keys = reserved();
      // The pools stay reserved on chain at their new revisions: hand them back either way.
      if (keys.length > 0) throw new KeyRecoveryError(`${message} If it never arrives, its unique codes are out of their pools.`, keys, updatedKits, { cause: error });
      throw new FulfillmentError(message, updatedKits, { cause: error });
    }
    delivery = { ...found, payload: input.delivery };
  }

  const warnings: string[] = [];
  let pendingRecoveryText: string | undefined;

  if (pending) {
    warnings.push('The delivery was sent but is not confirmed yet. It appears in the buyer\'s library once it lands; check the order before sending it again.');
    // Nothing else records which codes it holds once the page reloads.
    const keys = reserved();
    if (keys.length > 0) pendingRecoveryText = recoveryInstructions('If this delivery never arrives, its unique codes are out of their pools.', keys);
  }

  let status: OrderStatusUpdate | undefined;
  // Only a delivery seen on chain marks the order delivered.
  if (input.markDelivered && !pending) {
    try {
      status = await orderStatusService.createStatusUpdate(sellerId, order.id, { status: 'delivered', buyerId: order.buyerId });
    } catch (error) {
      logger.error('Delivered, but could not mark the order delivered:', error);
      warnings.push('The goods were delivered, but the order status could not be updated. Set it to Delivered manually.');
    }
  }

  return { delivery: pending ? { ...delivery, unconfirmed: true } : delivery, pending, status, updatedKits, warnings, ...(pendingRecoveryText ? { pendingRecoveryText } : {}) };
}
