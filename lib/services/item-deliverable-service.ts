import { logger } from '@/lib/logger';
/**
 * Item Deliverable Service (storefront v6)
 *
 * A seller's private delivery kit for a digital item: files (with their
 * keys), links, license keys and instructions, ECIES-encrypted to the
 * seller's own encryption key. One per item; the contract lets only the
 * item's owner write it.
 */

import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { chunk, MAX_IN_CLAUSE_VALUES } from './pagination-utils';
import { identifierToBase58, identifierStringToDocumentBytes, normalizeBytes } from './sdk-helpers';
import { decryptForSelf, encryptForSelf } from '../crypto/digital-delivery';
import { decodeKit, encodeKit } from './digital-delivery-plan';
import type { ItemDeliverable, ItemDeliverableDocument, ItemDeliverablePayload } from '../../types';

/** Reads after an unclear write: a node may lag the one that took the write. */
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const canonical = (kit: ItemDeliverablePayload) => JSON.stringify(decodeKit(encodeKit(kit)));

/** A kit write whose response failed and whose outcome the chain could not confirm either way. */
export class KitWriteUncertainError extends Error {
  constructor(readonly itemId: string, options?: { cause?: unknown }) {
    super('Could not confirm whether the delivery content was saved.', options);
    this.name = 'KitWriteUncertainError';
  }
}

/** A kit as the seller works with it: the document (its id and revision) and its decrypted content. */
export interface SellerKit {
  deliverable: ItemDeliverable;
  kit: ItemDeliverablePayload;
}

class ItemDeliverableService extends BaseDocumentService<ItemDeliverable> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.ITEM_DELIVERABLE, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): ItemDeliverable {
    const data = (doc.data || doc) as ItemDeliverableDocument;
    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      itemId: identifierToBase58(data.itemId) || '',
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      $revision: doc.$revision === undefined ? undefined : Number(doc.$revision),
      encryptedPayload: normalizeBytes(data.encryptedPayload) || new Uint8Array(),
    };
  }

  /** The kit document of each item that has one (one `in` query per batch). */
  async getForItems(itemIds: string[]): Promise<Map<string, ItemDeliverable>> {
    const found = new Map<string, ItemDeliverable>();
    for (const batch of chunk([...new Set(itemIds)], MAX_IN_CLAUSE_VALUES)) {
      const { documents } = await this.query({
        where: [['itemId', 'in', batch]],
        orderBy: [['itemId', 'asc']],
        limit: batch.length,
      });
      for (const doc of documents) found.set(doc.itemId, doc);
    }
    return found;
  }

  async getForItem(itemId: string): Promise<ItemDeliverable | null> {
    return (await this.getForItems([itemId])).get(itemId) ?? null;
  }

  async decryptKit(deliverable: ItemDeliverable, sellerPrivateKey: Uint8Array): Promise<ItemDeliverablePayload> {
    return decodeKit(await decryptForSelf(deliverable.encryptedPayload, sellerPrivateKey, deliverable.itemId));
  }

  /**
   * Decrypted kits for these items. An item with no kit is absent; a kit that
   * does not decrypt (written under a key this device does not hold) is
   * logged and left out, so the caller treats it as missing.
   */
  async loadKits(itemIds: string[], sellerPrivateKey: Uint8Array): Promise<Map<string, SellerKit>> {
    const kits = new Map<string, SellerKit>();
    for (const [itemId, deliverable] of await this.getForItems(itemIds)) {
      try {
        kits.set(itemId, { deliverable, kit: await this.decryptKit(deliverable, sellerPrivateKey) });
      } catch (error) {
        logger.warn(`Could not decrypt the delivery kit for item ${itemId}:`, error);
      }
    }
    return kits;
  }

  /**
   * Create the item's kit, or replace `existing` AT THE REVISION IT WAS READ.
   * Unlike `update()`, which re-reads the current revision, a replace from a
   * stale copy is refused: if another tab or device delivered in between and
   * took license keys, writing this copy would put those sent keys back in
   * the pool. The caller re-reads and tries again instead.
   */
  async saveKit(
    ownerId: string,
    itemId: string,
    kit: ItemDeliverablePayload,
    sellerPrivateKey: Uint8Array,
    existing: ItemDeliverable | null
  ): Promise<ItemDeliverable> {
    try {
      return await this.writeKit(ownerId, itemId, kit, sellerPrivateKey, existing);
    } catch (error) {
      // A failed response is not a failed write: a broadcast can land after
      // its response times out. Decide from the chain, or callers would
      // restore pools that were never taken (or skip ones that were).
      const outcome = await this.reconcile(itemId, kit, sellerPrivateKey, existing);
      if (outcome === 'absent') throw error;
      if (outcome === 'unknown') throw new KitWriteUncertainError(itemId, { cause: error });
      return outcome;
    }
  }

  /**
   * Whether the attempted write is on chain: the kit document when it is (one
   * revision past `existing`, or newly created, decrypting to exactly `kit`),
   * `absent` when the chain shows it did not land (still at the old revision
   * after the retries, or a different write took the revision), and `unknown`
   * when the chain could not be read to tell.
   */
  private async reconcile(
    itemId: string,
    kit: ItemDeliverablePayload,
    sellerPrivateKey: Uint8Array,
    existing: ItemDeliverable | null
  ): Promise<ItemDeliverable | 'absent' | 'unknown'> {
    const expectedRevision = existing ? (existing.$revision ?? 0) + 1 : 1;
    let readOnce = false;
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RECONCILE_DELAY_MS);
      try {
        const current = await this.getForItem(itemId);
        readOnce = true;
        if (!current || (current.$revision ?? 0) < expectedRevision) continue;
        if (current.$revision !== expectedRevision) return 'absent';
        const onChain = await this.decryptKit(current, sellerPrivateKey);
        return JSON.stringify(onChain) === canonical(kit) ? current : 'absent';
      } catch (error) {
        logger.warn(`Could not reconcile the delivery kit for item ${itemId}:`, error);
      }
    }
    return readOnce ? 'absent' : 'unknown';
  }

  private async writeKit(
    ownerId: string,
    itemId: string,
    kit: ItemDeliverablePayload,
    sellerPrivateKey: Uint8Array,
    existing: ItemDeliverable | null
  ): Promise<ItemDeliverable> {
    const data = {
      itemId: identifierStringToDocumentBytes(itemId),
      encryptedPayload: await encryptForSelf(encodeKit(kit), sellerPrivateKey, itemId),
    };
    if (!existing) {
      // A mutable document starts at revision 1; the create path may not echo it.
      const created = await this.create(ownerId, data);
      return { ...created, $revision: created.$revision ?? 1 };
    }
    if (existing.$revision === undefined) throw new Error('The delivery content has no known revision. Reload and try again.');
    const result = await stateTransitionService.updateDocument(this.contractId, this.documentType, existing.id, ownerId, data, existing.$revision);
    this.cache.delete(existing.id);
    if (!result.success || !result.document) {
      throw new Error(result.error || 'The delivery content changed elsewhere (another tab or device). Reload and try again.');
    }
    return this.transformDocument(result.document);
  }
}

export const itemDeliverableService = new ItemDeliverableService();
