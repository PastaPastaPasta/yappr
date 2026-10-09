/**
 * Store Item Service
 *
 * Manages product listings and their variants table (docs/STOREFRONT_V7.md):
 * up to five option types, combinations named by a canonical variant id. v7
 * stores the table as typed lists (lib/storefront/variant-codec.ts); v1–v6 as
 * a JSON string (lib/storefront/legacy-variants.ts). Callers see one model.
 */

import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES, storefrontArraysAreTyped, storefrontVariantsAreTyped } from '../constants';
import { LIST_LIMITS, ListLimitError, type ListLimits, assertListLimits, decodeStringList, encodeStringList, uniqueStrings } from '../typed-array-codecs';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import { itemImageLimit, itemSizeError } from '../storefront/storefront-contract';
import { decodeVariants, encodeVariants, findCombination, isInStock, priceRange, variantLabel, variantProblems } from '../storefront/variant-codec';
import { decodeLegacyVariants, encodeLegacyVariants } from '../storefront/legacy-variants';
import type {
  StoreItem,
  StoreItemDocument,
  StoreItemStatus,
  ItemFulfillment,
  ItemVariants,
  VariantCombination
} from '../../types';

/**
 * A string list as the configured storefront cut stores it: a list on v4, a
 * JSON string before. On v4 the contract bounds each list (tags 32 × 64 chars;
 * image URLs 8 × 512, http(s):// or ipfs://) and refuses one past that after
 * signing, so it throws a {@link ListLimitError} with a user-facing message
 * first. v1–v3 keep their own string caps and are not re-checked here.
 */
const storedList = (values: readonly string[], limits: ListLimits) => {
  const typed = storefrontArraysAreTyped();
  if (typed) assertListLimits(uniqueStrings(values), limits);
  return encodeStringList(values, typed);
};
const TAG_LIMITS = LIST_LIMITS.storeTags;
/** v7 stores up to 12 images (a variant names one by index); v4–v6 up to 8. */
const imageLimits = (): ListLimits => ({ ...LIST_LIMITS.storeImageUrls, maxItems: Math.max(itemImageLimit(), LIST_LIMITS.storeImageUrls.maxItems) });
/** A stored list (either shape) as the app models it; undefined when empty or absent. */
const listOf = (stored: unknown): string[] | undefined => {
  const values = decodeStringList(stored);
  return values.length > 0 ? values : undefined;
};

/**
 * The variants table as the configured cut stores it: the typed lists on v7,
 * the JSON string before (whose combination images are URLs, so it needs the
 * listing's `imageUrls`).
 */
const storedVariants = (variants: ItemVariants, imageUrls: readonly string[] | undefined) =>
  storefrontVariantsAreTyped() ? encodeVariants(variants) : encodeLegacyVariants(variants, imageUrls);

/** The table a stored item carries, read from whichever shape it was written in. */
const readVariants = (stored: unknown, imageUrls: readonly string[] | undefined): ItemVariants | undefined =>
  typeof stored === 'string' ? decodeLegacyVariants(stored, imageUrls) : decodeVariants(stored);

/**
 * Refuse, with a message for the seller, a listing the contract would refuse
 * after signing: a variants table it cannot store (`table`: the table being
 * written, or undefined when the write leaves the stored one as it is), an
 * item-level price or stock beside a v7 table, or a whole document past the
 * transition budget. `fields` is the document exactly as it will be sent.
 */
function assertStorable(fields: Record<string, unknown>, table: ItemVariants | undefined, imageUrls: readonly string[] | undefined): void {
  const typed = storefrontVariantsAreTyped();
  const imageCount = imageUrls?.length ?? 0;
  // The stored list keeps one of each URL, which would move every later image a
  // combination names by position.
  if (table?.combinations.some((combination) => combination.image !== undefined) && new Set(imageUrls).size !== imageCount) {
    throw new ListLimitError('The same image is in this listing twice. Remove the copy and save again.');
  }
  if (table) {
    const [problem] = variantProblems(table, { imageCount, legacy: !typed });
    if (problem) throw new ListLimitError(problem);
  }
  // v7 refuses an item-level price or stock beside the table (onePrice, oneStock).
  if (typed && fields.variants !== undefined && (fields.basePrice !== undefined || fields.stockQuantity !== undefined)) {
    throw new ListLimitError('A product with options is priced and stocked per combination. Clear its single price and stock first.');
  }
  const sizeError = itemSizeError(fields);
  if (sizeError) throw new ListLimitError(sizeError);
}

class StoreItemService extends BaseDocumentService<StoreItem> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_ITEM, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  /**
   * `update()` rebuilds the full replace from the TRANSFORMED item, where
   * `tags`/`imageUrls` are arrays, `variants` the app's table and `storeId`
   * base58. Re-encode each the way the contract stores it, or a stock edit
   * that names none of them re-sends parsed values that no cut accepts (lists
   * on storefront v1–v3, the app's table on every cut).
   */
  protected extractContentFields(doc: StoreItem): Record<string, unknown> {
    const fields = super.extractContentFields(doc);
    if (typeof fields.storeId === 'string') fields.storeId = fields.storeId ? identifierStringToDocumentBytes(fields.storeId) : undefined;
    if (Array.isArray(fields.tags)) fields.tags = storedList(fields.tags as string[], TAG_LIMITS);
    if (Array.isArray(fields.imageUrls)) fields.imageUrls = storedList(fields.imageUrls as string[], imageLimits());
    if (doc.variants) fields.variants = storedVariants(doc.variants, doc.imageUrls);
    return fields;
  }

  protected transformDocument(doc: Record<string, unknown>): StoreItem {
    const data = (doc.data || doc) as StoreItemDocument;
    const imageUrls = listOf(data.imageUrls);

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      storeId: identifierToBase58(data.storeId) || '',
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      $revision: doc.$revision as number | undefined,
      title: data.title,
      description: data.description,
      section: data.section,
      category: data.category,
      subcategory: data.subcategory,
      tags: listOf(data.tags),
      imageUrls,
      basePrice: data.basePrice,
      currency: data.currency,
      status: data.status,
      weight: data.weight,
      stockQuantity: data.stockQuantity,
      sku: data.sku,
      variants: readVariants(data.variants, imageUrls),
      fulfillment: data.fulfillment === 'digital' ? 'digital' : undefined
    };
  }

  /**
   * Get item by ID
   */
  async getById(itemId: string): Promise<StoreItem | null> {
    return this.get(itemId);
  }

  /**
   * These items read from Platform, never from the cache: for a check that
   * authorizes a delivery, where a listing switched to shipped elsewhere a
   * minute ago must not still pass as digital.
   */
  async getManyFresh(itemIds: string[]): Promise<StoreItem[]> {
    for (const id of itemIds) this.cache.delete(id);
    return this.getMany(itemIds);
  }

  /**
   * Whether a listing created without confirmation (`__createConfirmed ===
   * false`) is on chain yet, polled a few times. False is not proof it never
   * will be: the broadcast may still execute.
   */
  async isOnChain(itemId: string, attempts = 3): Promise<boolean> {
    return stateTransitionService.waitForDocument(this.contractId, this.documentType, itemId, { attempts });
  }

  /**
   * Get items for a store
   */
  async getByStore(storeId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ items: StoreItem[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      items: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get the complete product list for store management.
   * Keep each query within Platform's 100-document page limit.
   */
  async getAllByStore(storeId: string): Promise<StoreItem[]> {
    const items = new Map<string, StoreItem>();
    const seenCursors = new Set<string>();
    let startAfter: string | undefined;

    while (true) {
      const page = await this.getByStore(storeId, { limit: 100, startAfter });
      for (const item of page.items) items.set(item.id, item);
      if (page.items.length < 100) return Array.from(items.values());

      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new Error('Store product pagination did not advance');
      }
      seenCursors.add(page.nextCursor);
      startAfter = page.nextCursor;
    }
  }

  /**
   * Create a new item
   */
  async createItem(
    ownerId: string,
    storeId: string,
    data: {
      title: string;
      description?: string;
      section?: string;
      category?: string;
      subcategory?: string;
      tags?: string[];
      imageUrls?: string[];
      basePrice?: number;
      currency?: string;
      status?: StoreItemStatus;
      weight?: number;
      stockQuantity?: number;
      sku?: string;
      variants?: ItemVariants;
      fulfillment?: ItemFulfillment;
    }
  ): Promise<StoreItem> {
    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(storeId),
      title: data.title,
      status: data.status || 'active'
    };

    if (data.description) documentData.description = data.description;
    if (data.section) documentData.section = data.section;
    if (data.category) documentData.category = data.category;
    if (data.subcategory) documentData.subcategory = data.subcategory;
    if (data.tags) documentData.tags = storedList(data.tags, TAG_LIMITS);
    if (data.imageUrls) documentData.imageUrls = storedList(data.imageUrls, imageLimits());
    if (data.basePrice !== undefined) documentData.basePrice = data.basePrice;
    if (data.currency) documentData.currency = data.currency;
    if (data.weight !== undefined) documentData.weight = data.weight;
    if (data.stockQuantity !== undefined) documentData.stockQuantity = data.stockQuantity;
    if (data.sku) documentData.sku = data.sku;
    if (data.variants) documentData.variants = storedVariants(data.variants, data.imageUrls);
    // Absent means shipped, so a physical product writes exactly what v5 accepts.
    if (data.fulfillment === 'digital') documentData.fulfillment = 'digital';

    assertStorable(documentData, data.variants, data.imageUrls);
    return this.create(ownerId, documentData);
  }

  /**
   * Update an item
   */
  async updateItem(
    itemId: string,
    ownerId: string,
    storeId: string,
    data: Partial<{
      title: string;
      description: string;
      section: string;
      category: string;
      subcategory: string;
      tags: string[];
      imageUrls: string[];
      basePrice: number;
      currency: string;
      status: StoreItemStatus;
      weight: number;
      stockQuantity: number;
      sku: string;
      variants: ItemVariants;
      fulfillment: ItemFulfillment;
    }>
  ): Promise<StoreItem> {
    // Fetch existing item to preserve required fields
    const existing = await this.get(itemId);
    if (!existing) {
      throw new Error('Item not found');
    }

    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(storeId),
      title: data.title ?? existing.title,
      status: data.status ?? existing.status
    };

    // A key given as undefined clears that optional field (e.g. unticking variants
    // or stock tracking); an omitted key preserves the stored value.
    if ('description' in data) documentData.description = data.description;
    if ('section' in data) documentData.section = data.section;
    if ('category' in data) documentData.category = data.category;
    if ('subcategory' in data) documentData.subcategory = data.subcategory;
    // An empty list clears the field too (the encoder answers undefined for none).
    if ('tags' in data) documentData.tags = data.tags && storedList(data.tags, TAG_LIMITS);
    if ('imageUrls' in data) documentData.imageUrls = data.imageUrls && storedList(data.imageUrls, imageLimits());
    if ('basePrice' in data) documentData.basePrice = data.basePrice;
    if ('currency' in data) documentData.currency = data.currency;
    if ('weight' in data) documentData.weight = data.weight;
    if ('stockQuantity' in data) documentData.stockQuantity = data.stockQuantity;
    if ('sku' in data) documentData.sku = data.sku;
    // The table is re-encoded whenever the images change too: on v1–v6 a
    // combination's image is stored as its URL, not an index.
    const writesTable = 'variants' in data || 'imageUrls' in data;
    const imageUrls = 'imageUrls' in data ? data.imageUrls : existing.imageUrls;
    const variants = 'variants' in data ? data.variants : existing.variants;
    if (writesTable) documentData.variants = variants && storedVariants(variants, imageUrls);
    if ('fulfillment' in data) documentData.fulfillment = data.fulfillment === 'digital' ? 'digital' : undefined;

    // What update() will send: the stored fields, with these changes over them.
    // The table is judged only when this edit writes it (or moves its images):
    // a status or stock edit must never be blocked by a stored v1-v6 table.
    const merged: Record<string, unknown> = { ...this.extractContentFields(existing), ...documentData };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    assertStorable(merged, writesTable ? variants : undefined, imageUrls);
    return this.update(itemId, ownerId, documentData);
  }

  /**
   * "Delete" a product. `storeItem` is `canBeDeleted: false` (its reviews
   * reference it), so the listing is archived with the `deleted` status, which
   * every buyer-facing read already filters out.
   */
  async archiveItem(itemId: string, ownerId: string, storeId: string): Promise<StoreItem> {
    return this.updateItem(itemId, ownerId, storeId, { status: 'deleted' });
  }

  // =========================================================================
  // Variant Helper Methods (a combination is named by its canonical variant id)
  // =========================================================================

  /** The combination `variantId` names, if the item still offers it. */
  getCombination(item: StoreItem, variantId: string | undefined): VariantCombination | undefined {
    return findCombination(item.variants, variantId);
  }

  /**
   * The variant's full name for a cart line or order ("Red / Large"). Never
   * cut: on v1–v6 it is what tells two combinations apart (see
   * {@link getLineCombination}); the order's size check bounds it.
   */
  getVariantLabel(item: StoreItem, variantId: string | undefined): string | undefined {
    const combination = this.getCombination(item, variantId);
    return combination && item.variants ? variantLabel(item.variants, combination) : undefined;
  }

  /** What checkout charges: the variant's price, else the base price, else 0. */
  getPrice(item: StoreItem, variantId?: string): number {
    return this.getCombination(item, variantId)?.price ?? item.basePrice ?? 0;
  }

  /**
   * The combination a cart or order line names. On v7 its id is enough. v1–v6
   * number options by position on every read, so once the seller reorders or
   * removes an option an old id can name a different combination: there the
   * line's label must agree too, or the line names nothing.
   */
  getLineCombination(item: StoreItem, line: { variantId?: string; variantLabel?: string }): VariantCombination | undefined {
    const combination = this.getCombination(item, line.variantId);
    if (!combination || !item.variants || storefrontVariantsAreTyped()) return combination;
    return line.variantLabel === variantLabel(item.variants, combination) ? combination : undefined;
  }

  /** The SKU of the variant a line names, else the item's own. */
  getSku(item: StoreItem, line: { variantId?: string; variantLabel?: string }): string | undefined {
    return this.getLineCombination(item, line)?.sku ?? item.sku;
  }

  /** The variant's weight in grams, else the item's (for shipping). */
  getWeight(item: StoreItem, variantId?: string): number | undefined {
    return this.getCombination(item, variantId)?.weight ?? item.weight;
  }

  /**
   * Whether the item (or the named variant) tracks inventory. A v7 variant
   * item tracks every combination or none.
   */
  hasInventoryTracking(item: StoreItem, variantId?: string): boolean {
    if (item.variants) {
      if (variantId) return this.getCombination(item, variantId)?.stock !== undefined;
      return item.variants.combinations.some((combination) => combination.stock !== undefined);
    }
    return item.stockQuantity !== undefined && item.stockQuantity !== null;
  }

  /**
   * Units available: the variant's stock on a variant item (0 for a variant
   * it no longer offers), else stockQuantity. Infinity when untracked.
   */
  getStock(item: StoreItem, variantId?: string): number {
    if (item.variants) {
      const combination = this.getCombination(item, variantId);
      if (!combination) return 0;
      return combination.stock ?? Infinity;
    }
    return item.stockQuantity ?? Infinity;
  }

  /** Whether nothing can be bought: every combination at 0, or a tracked stockQuantity of 0. */
  isOutOfStock(item: StoreItem): boolean {
    if (item.variants) return !item.variants.combinations.some(isInStock);
    if (item.stockQuantity === undefined || item.stockQuantity === null) return false;
    return item.stockQuantity <= 0;
  }

  /** The lowest and highest prices: over the combinations, or the base price twice. */
  getPriceRange(item: StoreItem): { min: number; max: number } {
    if (item.variants) return priceRange(item.variants);
    const price = item.basePrice || 0;
    return { min: price, max: price };
  }
}

export const storeItemService = new StoreItemService();
