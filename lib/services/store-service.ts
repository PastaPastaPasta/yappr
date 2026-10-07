import { logger } from '@/lib/logger';
/**
 * Store Service
 *
 * Manages store documents for the storefront feature.
 * One store per user (unique $ownerId index).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES, storefrontIsV6 } from '../constants';
import { parseJsonArray } from '../utils/json-parsing';
import { DISCOVERY_SCAN_LIMIT, DISCOVERY_SCAN_TTL_MS, newestFirst } from './pagination-utils';
import type {
  Store,
  StoreDocument,
  StoreStatus,
  SocialLink,
  LegacyStoreContactMethods,
  ParsedPaymentUri
} from '../../types';

/**
 * Convert legacy contact methods format to SocialLink array.
 */
function convertLegacyContactMethods(legacy: LegacyStoreContactMethods): SocialLink[] | undefined {
  const result: SocialLink[] = [];
  if (legacy.email) result.push({ platform: 'email', handle: legacy.email });
  if (legacy.signal) result.push({ platform: 'signal', handle: legacy.signal });
  if (legacy.twitter) result.push({ platform: 'twitter', handle: legacy.twitter });
  if (legacy.telegram) result.push({ platform: 'telegram', handle: legacy.telegram });
  return result.length > 0 ? result : undefined;
}

/**
 * Parse contact methods that may be in new format (SocialLink[]) or legacy format.
 */
function parseContactMethods(value: unknown): SocialLink[] | undefined {
  if (!value) return undefined;

  // Already an array - could be new format directly
  if (Array.isArray(value)) return value as SocialLink[];

  // Legacy object format (not a string)
  if (typeof value === 'object') {
    return convertLegacyContactMethods(value as LegacyStoreContactMethods);
  }

  // JSON string - could be new or legacy format
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as SocialLink[];
      return convertLegacyContactMethods(parsed as LegacyStoreContactMethods);
    } catch {
      logger.error('Failed to parse contactMethods:', value);
    }
  }

  return undefined;
}

class StoreService extends BaseDocumentService<Store> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  /**
   * `update()` rebuilds the full replace from the TRANSFORMED store, where
   * `paymentUris` and `contactMethods` are arrays. Both are JSON strings on
   * every storefront cut, so re-encode them, or an update that does not name
   * them re-sends values no cut accepts.
   */
  protected extractContentFields(doc: Store): Record<string, unknown> {
    const fields = super.extractContentFields(doc);
    for (const key of ['paymentUris', 'contactMethods'] as const) {
      if (fields[key] && typeof fields[key] === 'object') fields[key] = JSON.stringify(fields[key]);
    }
    return fields;
  }

  protected transformDocument(doc: Record<string, unknown>): Store {
    const data = (doc.data || doc) as StoreDocument;

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      $revision: doc.$revision as number | undefined,
      name: data.name,
      description: data.description,
      logoUrl: data.logoUrl,
      bannerUrl: data.bannerUrl,
      status: data.status,
      paymentUris: parseJsonArray<ParsedPaymentUri>(data.paymentUris, 'paymentUris'),
      defaultCurrency: data.defaultCurrency,
      policies: data.policies,
      location: data.location,
      contactMethods: parseContactMethods(data.contactMethods),
      category: data.category
    };
  }

  /**
   * Get store by owner ID (one store per user)
   */
  async getByOwner(ownerId: string): Promise<Store | null> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['$ownerId', 'asc']],
      limit: 1
    });

    return documents[0] || null;
  }

  /**
   * Get store by document ID
   */
  async getById(storeId: string): Promise<Store | null> {
    return this.get(storeId);
  }

  /**
   * Read the store from the network, bypassing the cache. Unlike get(), a failed
   * read throws, so checkout can refuse to proceed when status is unknown.
   */
  async getCurrent(storeId: string): Promise<Store | null> {
    const { documents } = await this.query({
      where: [['$id', '==', storeId]],
      limit: 1
    });
    return documents[0] || null;
  }

  /**
   * Create a new store
   */
  async createStore(
    ownerId: string,
    data: {
      name: string;
      description?: string;
      logoUrl?: string;
      bannerUrl?: string;
      status?: StoreStatus;
      paymentUris?: ParsedPaymentUri[];
      defaultCurrency?: string;
      policies?: string;
      location?: string;
      contactMethods?: SocialLink[];
      /** Required on v6 (a slug, see `normalizeStoreCategory`); no earlier cut has the property. */
      category?: string;
    }
  ): Promise<Store> {
    const documentData: Record<string, unknown> = {
      name: data.name,
      status: data.status || 'active'
    };

    if (data.description) documentData.description = data.description;
    if (data.logoUrl) documentData.logoUrl = data.logoUrl;
    if (data.bannerUrl) documentData.bannerUrl = data.bannerUrl;
    if (data.paymentUris) documentData.paymentUris = JSON.stringify(data.paymentUris);
    if (data.defaultCurrency) documentData.defaultCurrency = data.defaultCurrency;
    if (data.policies) documentData.policies = data.policies;
    if (data.location) documentData.location = data.location;
    if (data.contactMethods) documentData.contactMethods = JSON.stringify(data.contactMethods);
    if (data.category) documentData.category = data.category;

    return this.create(ownerId, documentData);
  }

  /**
   * Update store
   */
  async updateStore(
    storeId: string,
    ownerId: string,
    data: Partial<{
      name: string;
      description: string;
      logoUrl: string;
      bannerUrl: string;
      status: StoreStatus;
      paymentUris: ParsedPaymentUri[];
      defaultCurrency: string;
      policies: string;
      location: string;
      contactMethods: SocialLink[];
      category: string;
    }>
  ): Promise<Store> {
    const documentData: Record<string, unknown> = {};

    // A key given as undefined clears that optional field; an omitted key keeps it.
    if (data.name !== undefined) documentData.name = data.name;
    if (data.status !== undefined) documentData.status = data.status;
    if ('description' in data) documentData.description = data.description;
    if ('logoUrl' in data) documentData.logoUrl = data.logoUrl;
    if ('bannerUrl' in data) documentData.bannerUrl = data.bannerUrl;
    if ('paymentUris' in data) documentData.paymentUris = data.paymentUris && JSON.stringify(data.paymentUris);
    if ('defaultCurrency' in data) documentData.defaultCurrency = data.defaultCurrency;
    if ('policies' in data) documentData.policies = data.policies;
    if ('location' in data) documentData.location = data.location;
    if ('contactMethods' in data) documentData.contactMethods = data.contactMethods && JSON.stringify(data.contactMethods);
    if (data.category !== undefined) documentData.category = data.category;

    return this.update(storeId, ownerId, documentData);
  }

  /**
   * The newest active stores for discovery, `limit` at most. On v6 that is one
   * page of the `byStatus [status, $createdAt]` index, always complete. Before
   * v6 a store is only indexed on `$ownerId`, so neither status nor creation
   * time can be queried: this reads every store in owner order (up to
   * {@link DISCOVERY_SCAN_LIMIT}), keeps the active ones and sorts them by
   * creation time. `complete` is false when that cap cut the read short, so
   * the order only covers the stores read; the page says so.
   */
  async getNewestActiveStores(limit = 50): Promise<{ stores: Store[]; complete: boolean }> {
    if (storefrontIsV6()) {
      const { documents } = await this.query({
        where: [['status', '==', 'active']],
        orderBy: [['status', 'asc'], ['$createdAt', 'desc']],
        limit,
      });
      return { stores: documents, complete: true };
    }
    const { stores, complete } = await this.scanNewestActiveStores();
    return { stores: stores.slice(0, limit), complete };
  }

  /** The newest active stores in one category (v6 `byCategory [status, category, $createdAt]`), `limit` at most. */
  async getNewestActiveStoresInCategory(category: string, limit = 50): Promise<Store[]> {
    const { documents } = await this.query({
      where: [['status', '==', 'active'], ['category', '==', category]],
      orderBy: [['status', 'asc'], ['category', 'asc'], ['$createdAt', 'desc']],
      limit,
    });
    return documents;
  }

  /** A full clear (a create runs one) drops the discovery scan too, so a new one is listed. */
  clearCache(documentId?: string): void {
    super.clearCache(documentId);
    if (!documentId) this.newestScan = null;
  }

  /** The full discovery scan, newest first, held for two minutes (it is up to 10 queries). */
  private newestScan: { at: number; result: Promise<{ stores: Store[]; complete: boolean }> } | null = null;

  private scanNewestActiveStores(): Promise<{ stores: Store[]; complete: boolean }> {
    if (this.newestScan && Date.now() - this.newestScan.at < DISCOVERY_SCAN_TTL_MS) return this.newestScan.result;
    const result = this.queryAll({ orderBy: [['$ownerId', 'asc']] }, DISCOVERY_SCAN_LIMIT)
      .then(({ documents, reachedLimit }) => ({
        stores: newestFirst(documents.filter(store => store.status === 'active')),
        complete: !reachedLimit,
      }));
    const scan = { at: Date.now(), result };
    this.newestScan = scan;
    // A failed scan is not held.
    result.catch(() => {
      if (this.newestScan === scan) this.newestScan = null;
    });
    return result;
  }

  /**
   * Check if user has a store
   */
  async hasStore(ownerId: string): Promise<boolean> {
    const store = await this.getByOwner(ownerId);
    return store !== null;
  }

  /**
   * Update store with partial data, automatically preserving existing fields.
   * This is a convenience method that fetches the current store, merges changes,
   * and submits the update. Use this instead of updateStore when you only want
   * to change a few fields without manually specifying all existing values.
   */
  async patchStore(
    storeId: string,
    ownerId: string,
    changes: Partial<{
      name: string;
      description: string;
      logoUrl: string;
      bannerUrl: string;
      status: StoreStatus;
      paymentUris: ParsedPaymentUri[];
      defaultCurrency: string;
      policies: string;
      location: string;
      contactMethods: SocialLink[];
      category: string;
    }>
  ): Promise<Store> {
    const existing = await this.getById(storeId);
    if (!existing) {
      throw new Error('Store not found');
    }

    // Merge existing values with changes
    const merged = {
      name: changes.name ?? existing.name,
      description: changes.description ?? existing.description,
      logoUrl: changes.logoUrl ?? existing.logoUrl,
      bannerUrl: changes.bannerUrl ?? existing.bannerUrl,
      status: changes.status ?? existing.status,
      paymentUris: changes.paymentUris ?? existing.paymentUris,
      defaultCurrency: changes.defaultCurrency ?? existing.defaultCurrency,
      policies: changes.policies ?? existing.policies,
      location: changes.location ?? existing.location,
      contactMethods: changes.contactMethods ?? existing.contactMethods,
      category: changes.category ?? existing.category
    };

    return this.updateStore(storeId, ownerId, merged);
  }
}

export const storeService = new StoreService();
