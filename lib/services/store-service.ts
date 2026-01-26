/**
 * Store Service
 *
 * Manages store documents for the storefront feature.
 * One store per user (unique $ownerId index).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import type {
  Store,
  StoreDocument,
  StoreStatus,
  SocialLink,
  LegacyStoreContactMethods,
  ParsedPaymentUri
} from '../types';

class StoreService extends BaseDocumentService<Store> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.STORE, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): Store {
    const data = (doc.data || doc) as StoreDocument;

    // Parse JSON fields - handle both string (from SDK query) and object (from state transition)
    let paymentUris: ParsedPaymentUri[] | undefined;
    if (data.paymentUris) {
      if (Array.isArray(data.paymentUris)) {
        paymentUris = data.paymentUris;
      } else if (typeof data.paymentUris === 'string') {
        try {
          paymentUris = JSON.parse(data.paymentUris);
        } catch {
          console.error('Failed to parse paymentUris:', data.paymentUris);
        }
      }
    }

    let contactMethods: SocialLink[] | undefined;
    if (data.contactMethods) {
      if (Array.isArray(data.contactMethods)) {
        // New format: SocialLink[]
        contactMethods = data.contactMethods;
      } else if (typeof data.contactMethods === 'object') {
        // Legacy format: { email?: string, twitter?: string, ... } - convert to SocialLink[]
        const legacy = data.contactMethods as LegacyStoreContactMethods;
        contactMethods = [];
        if (legacy.email) contactMethods.push({ platform: 'email', handle: legacy.email });
        if (legacy.signal) contactMethods.push({ platform: 'signal', handle: legacy.signal });
        if (legacy.twitter) contactMethods.push({ platform: 'twitter', handle: legacy.twitter });
        if (legacy.telegram) contactMethods.push({ platform: 'telegram', handle: legacy.telegram });
        if (contactMethods.length === 0) contactMethods = undefined;
      } else if (typeof data.contactMethods === 'string') {
        try {
          const parsed = JSON.parse(data.contactMethods);
          if (Array.isArray(parsed)) {
            // New format stored as JSON string
            contactMethods = parsed;
          } else {
            // Legacy format stored as JSON string - convert to SocialLink[]
            const legacy = parsed as LegacyStoreContactMethods;
            contactMethods = [];
            if (legacy.email) contactMethods.push({ platform: 'email', handle: legacy.email });
            if (legacy.signal) contactMethods.push({ platform: 'signal', handle: legacy.signal });
            if (legacy.twitter) contactMethods.push({ platform: 'twitter', handle: legacy.twitter });
            if (legacy.telegram) contactMethods.push({ platform: 'telegram', handle: legacy.telegram });
            if (contactMethods.length === 0) contactMethods = undefined;
          }
        } catch {
          console.error('Failed to parse contactMethods:', data.contactMethods);
        }
      }
    }

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
      paymentUris,
      defaultCurrency: data.defaultCurrency,
      policies: data.policies,
      location: data.location,
      contactMethods
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
}

export const storeService = new StoreService();
