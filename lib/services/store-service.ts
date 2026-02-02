/**
 * Store Service
 *
 * Manages store documents for the storefront feature.
 * One store per user (unique $ownerId index).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { parseJsonArray } from '../utils/json-parsing';
import type {
  Store,
  StoreDocument,
  StoreStatus,
  SocialLink,
  LegacyStoreContactMethods,
  ParsedPaymentUri
} from '../types';

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
      console.error('Failed to parse contactMethods:', value);
    }
  }

  return undefined;
}

class StoreService extends BaseDocumentService<Store> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE, YAPPR_STOREFRONT_CONTRACT_ID);
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
      contactMethods: parseContactMethods(data.contactMethods)
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
    }>
  ): Promise<Store> {
    const documentData: Record<string, unknown> = {};

    if (data.name !== undefined) documentData.name = data.name;
    if (data.description !== undefined) documentData.description = data.description;
    if (data.logoUrl !== undefined) documentData.logoUrl = data.logoUrl;
    if (data.bannerUrl !== undefined) documentData.bannerUrl = data.bannerUrl;
    if (data.status !== undefined) documentData.status = data.status;
    if (data.paymentUris !== undefined) documentData.paymentUris = JSON.stringify(data.paymentUris);
    if (data.defaultCurrency !== undefined) documentData.defaultCurrency = data.defaultCurrency;
    if (data.policies !== undefined) documentData.policies = data.policies;
    if (data.location !== undefined) documentData.location = data.location;
    if (data.contactMethods !== undefined) documentData.contactMethods = JSON.stringify(data.contactMethods);

    return this.update(storeId, ownerId, documentData);
  }

  /**
   * Get all active stores (for discovery)
   */
  async getActiveStores(options: { limit?: number; startAfter?: string } = {}): Promise<{ stores: Store[]; nextCursor?: string }> {
    // Note: Store only has an index on $ownerId, so we can only order by that
    // Client-side filtering will be needed for status
    const { documents } = await this.query({
      orderBy: [['$ownerId', 'asc']],
      limit: options.limit || 20,
      startAfter: options.startAfter
    });

    // Filter to active stores client-side
    const activeStores = documents.filter(store => store.status === 'active');

    return {
      stores: activeStores,
      nextCursor: documents.length > 0 ? documents[documents.length - 1].id : undefined
    };
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
      contactMethods: changes.contactMethods ?? existing.contactMethods
    };

    return this.updateStore(storeId, ownerId, merged);
  }
}

export const storeService = new StoreService();
