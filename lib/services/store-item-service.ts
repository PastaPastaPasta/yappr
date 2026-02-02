/**
 * Store Item Service
 *
 * Manages product listings with embedded variants.
 * Supports two-level variant hierarchy (e.g., Color + Size).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, stringToIdentifierBytes, type DocumentWhereClause } from './sdk-helpers';
import type {
  StoreItem,
  StoreItemDocument,
  StoreItemStatus,
  ItemVariants,
  VariantAxis,
  VariantCombination
} from '../types';

/**
 * Parse a JSON field that may be an array or a JSON string.
 */
function parseJsonArray<T>(value: unknown, fieldName: string): T[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T[];
    } catch {
      console.error(`Failed to parse ${fieldName}:`, value);
    }
  }
  return undefined;
}

/**
 * Parse a JSON field that may be an object or a JSON string.
 */
function parseJsonObject<T>(value: unknown, fieldName: string): T | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      console.error(`Failed to parse ${fieldName}:`, value);
    }
  }
  return undefined;
}

class StoreItemService extends BaseDocumentService<StoreItem> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE_ITEM, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): StoreItem {
    const data = (doc.data || doc) as StoreItemDocument;

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
      tags: parseJsonArray<string>(data.tags, 'tags'),
      imageUrls: parseJsonArray<string>(data.imageUrls, 'imageUrls'),
      basePrice: data.basePrice,
      currency: data.currency,
      status: data.status,
      weight: data.weight,
      stockQuantity: data.stockQuantity,
      sku: data.sku,
      variants: parseJsonObject<ItemVariants>(data.variants, 'variants')
    };
  }

  /**
   * Get item by ID
   */
  async getById(itemId: string): Promise<StoreItem | null> {
    return this.get(itemId);
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
   * Get items by category
   */
  async getByCategory(section: string, category?: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ items: StoreItem[]; nextCursor?: string }> {
    const where: DocumentWhereClause[] = [['section', '==', section]];
    if (category) {
      where.push(['category', '==', category]);
    }

    const { documents } = await this.query({
      where,
      orderBy: [['section', 'asc'], ['category', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    // Filter to active items
    const activeItems = documents.filter(item => item.status === 'active');

    return {
      items: activeItems,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get items by owner
   */
  async getByOwner(ownerId: string, options: { limit?: number; startAfter?: string } = {}): Promise<{ items: StoreItem[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      items: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
  }

  /**
   * Get active items for browsing
   */
  async getActiveItems(options: { limit?: number; startAfter?: string } = {}): Promise<{ items: StoreItem[]; nextCursor?: string }> {
    const { documents } = await this.query({
      where: [['status', '==', 'active']],
      orderBy: [['status', 'asc'], ['$createdAt', 'desc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    return {
      items: documents,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
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
    }
  ): Promise<StoreItem> {
    const documentData: Record<string, unknown> = {
      storeId: stringToIdentifierBytes(storeId),
      title: data.title,
      status: data.status || 'active'
    };

    if (data.description) documentData.description = data.description;
    if (data.section) documentData.section = data.section;
    if (data.category) documentData.category = data.category;
    if (data.subcategory) documentData.subcategory = data.subcategory;
    if (data.tags) documentData.tags = JSON.stringify(data.tags);
    if (data.imageUrls) documentData.imageUrls = JSON.stringify(data.imageUrls);
    if (data.basePrice !== undefined) documentData.basePrice = data.basePrice;
    if (data.currency) documentData.currency = data.currency;
    if (data.weight !== undefined) documentData.weight = data.weight;
    if (data.stockQuantity !== undefined) documentData.stockQuantity = data.stockQuantity;
    if (data.sku) documentData.sku = data.sku;
    if (data.variants) documentData.variants = JSON.stringify(data.variants);

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
    }>
  ): Promise<StoreItem> {
    // Fetch existing item to preserve required fields
    const existing = await this.get(itemId);
    if (!existing) {
      throw new Error('Item not found');
    }

    const documentData: Record<string, unknown> = {
      storeId: stringToIdentifierBytes(storeId),
      title: data.title ?? existing.title,
      status: data.status ?? existing.status
    };

    if (data.description !== undefined) documentData.description = data.description;
    if (data.section !== undefined) documentData.section = data.section;
    if (data.category !== undefined) documentData.category = data.category;
    if (data.subcategory !== undefined) documentData.subcategory = data.subcategory;
    if (data.tags !== undefined) documentData.tags = JSON.stringify(data.tags);
    if (data.imageUrls !== undefined) documentData.imageUrls = JSON.stringify(data.imageUrls);
    if (data.basePrice !== undefined) documentData.basePrice = data.basePrice;
    if (data.currency !== undefined) documentData.currency = data.currency;
    if (data.weight !== undefined) documentData.weight = data.weight;
    if (data.stockQuantity !== undefined) documentData.stockQuantity = data.stockQuantity;
    if (data.sku !== undefined) documentData.sku = data.sku;
    if (data.variants !== undefined) documentData.variants = JSON.stringify(data.variants);

    return this.update(itemId, ownerId, documentData);
  }

  // =========================================================================
  // Variant Helper Methods
  // =========================================================================

  /**
   * Get variant axes from an item
   */
  getVariantAxes(item: StoreItem): VariantAxis[] {
    return item.variants?.axes || [];
  }

  /**
   * Get available options for an axis, optionally filtered by prior selections
   */
  getAxisOptions(item: StoreItem, axisName: string, priorSelections?: Record<string, string>): string[] {
    if (!item.variants) return [];

    const axis = item.variants.axes.find(a => a.name === axisName);
    if (!axis) return [];

    if (!priorSelections || Object.keys(priorSelections).length === 0) {
      return axis.options;
    }

    // Filter options based on available combinations with prior selections
    const availableOptions = new Set<string>();
    const axisIndex = item.variants.axes.findIndex(a => a.name === axisName);

    for (const combo of item.variants.combinations) {
      const keyParts = combo.key.split('|');

      // Check if this combination matches all prior selections
      let matches = true;
      for (const [selAxis, selValue] of Object.entries(priorSelections)) {
        const selIndex = item.variants.axes.findIndex(a => a.name === selAxis);
        if (selIndex >= 0 && keyParts[selIndex] !== selValue) {
          matches = false;
          break;
        }
      }

      // Include option if stock is undefined (unlimited) or > 0
      if (matches && (combo.stock === undefined || combo.stock === null || combo.stock > 0)) {
        availableOptions.add(keyParts[axisIndex]);
      }
    }

    return axis.options.filter(opt => availableOptions.has(opt));
  }

  /**
   * Find a combination by key
   */
  getCombination(item: StoreItem, key: string): VariantCombination | null {
    if (!item.variants) return null;
    return item.variants.combinations.find(c => c.key === key) || null;
  }

  /**
   * Build a variant key from selections
   */
  buildVariantKey(selections: Record<string, string>, axes: VariantAxis[]): string {
    return axes.map(axis => selections[axis.name] || '').join('|');
  }

  /**
   * Get price for an item (base price or variant price)
   */
  getPrice(item: StoreItem, variantKey?: string): number {
    if (variantKey && item.variants) {
      const combo = this.getCombination(item, variantKey);
      if (combo) return combo.price;
    }
    return item.basePrice || 0;
  }

  /**
   * Check if item has inventory tracking enabled.
   * For variants: tracked if at least one variant has stock defined.
   * For base items: tracked if stockQuantity is defined.
   */
  hasInventoryTracking(item: StoreItem, variantKey?: string): boolean {
    if (variantKey && item.variants) {
      const combo = this.getCombination(item, variantKey);
      return combo?.stock !== undefined && combo?.stock !== null;
    }
    if (item.variants) {
      // Check if any variant has stock tracking
      return item.variants.combinations.some(c => c.stock !== undefined && c.stock !== null);
    }
    return item.stockQuantity !== undefined && item.stockQuantity !== null;
  }

  /**
   * Get stock for an item (base stock or variant stock).
   * Returns Infinity if inventory is not tracked.
   */
  getStock(item: StoreItem, variantKey?: string): number {
    if (variantKey && item.variants) {
      const combo = this.getCombination(item, variantKey);
      if (combo) {
        // If variant stock is undefined, inventory is not tracked - return Infinity
        if (combo.stock === undefined || combo.stock === null) {
          return Infinity;
        }
        return combo.stock;
      }
    }
    // If stockQuantity is undefined, inventory is not tracked - return Infinity
    if (item.stockQuantity === undefined || item.stockQuantity === null) {
      return Infinity;
    }
    return item.stockQuantity;
  }

  /**
   * Check if item is out of stock.
   * For variants: out of stock only if ALL variants have stock explicitly set to 0.
   * Variants with undefined stock are considered available (unlimited).
   * For base items: out of stock only if stockQuantity is explicitly set to 0.
   */
  isOutOfStock(item: StoreItem): boolean {
    if (item.variants) {
      // Out of stock only if ALL variants have stock defined AND all are 0 or less
      return item.variants.combinations.every(c =>
        c.stock !== undefined && c.stock !== null && c.stock <= 0
      );
    }
    // If stockQuantity is undefined, inventory is not tracked - item is available
    if (item.stockQuantity === undefined || item.stockQuantity === null) {
      return false;
    }
    return item.stockQuantity <= 0;
  }

  /**
   * Get the lowest and highest prices for an item with variants
   */
  getPriceRange(item: StoreItem): { min: number; max: number } {
    if (!item.variants || item.variants.combinations.length === 0) {
      const price = item.basePrice || 0;
      return { min: price, max: price };
    }

    const prices = item.variants.combinations.map(c => c.price);
    return {
      min: Math.min(...prices),
      max: Math.max(...prices)
    };
  }
}

export const storeItemService = new StoreItemService();
