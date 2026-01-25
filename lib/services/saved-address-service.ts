/**
 * Saved Address Service
 *
 * Manages encrypted saved shipping addresses for users.
 * Addresses are encrypted using ECIES with the user's encryption public key (purpose=1).
 * Single document per user containing an array of encrypted addresses (up to ~8-10 addresses).
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { privateFeedCryptoService } from './private-feed-crypto-service';
import { identityService } from './identity-service';
import { toUint8Array } from './sdk-helpers';
import type {
  SavedAddress,
  SavedAddressPayload,
  SavedAddressDocument,
  ShippingAddress,
  BuyerContact
} from '../types';

// AAD context for address encryption
const AAD_SHIPPING = 'yappr/shipping/v1';

// Current payload schema version
const PAYLOAD_VERSION = 1;

/**
 * Normalize key data from various formats to Uint8Array
 */
function normalizeKeyData(data: unknown): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'string') {
    try {
      return new Uint8Array(Buffer.from(data, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Generate a simple UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface InternalSavedAddressDocument {
  id: string;
  ownerId: string;
  createdAt: Date;
  $revision?: number;
  encryptedPayload: Uint8Array;
}

class SavedAddressService extends BaseDocumentService<InternalSavedAddressDocument> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.SAVED_ADDRESS, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): InternalSavedAddressDocument {
    const data = (doc.data || doc) as SavedAddressDocument;

    // Convert encrypted payload to Uint8Array
    const encryptedPayload = toUint8Array(data.encryptedPayload) || new Uint8Array();

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      $revision: (data.$revision || doc.$revision) as number | undefined,
      encryptedPayload
    };
  }

  /**
   * Get user's saved address document (raw, encrypted)
   */
  async getForUser(userId: string): Promise<InternalSavedAddressDocument | null> {
    const { documents } = await this.query({
      where: [['$ownerId', '==', userId]],
      orderBy: [['$ownerId', 'asc']],
      limit: 1
    });

    return documents.length > 0 ? documents[0] : null;
  }

  /**
   * Get user's encryption public key from their identity
   */
  async getUserEncryptionPublicKey(userId: string): Promise<Uint8Array | null> {
    const identity = await identityService.getIdentity(userId);
    if (!identity) return null;

    // Find encryption key (purpose=1, type=0 ECDSA_SECP256K1, not disabled)
    const encryptionKey = identity.publicKeys.find(
      (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
    );

    if (!encryptionKey?.data) return null;
    return normalizeKeyData(encryptionKey.data);
  }

  /**
   * Decrypt and return saved addresses for a user
   * @param userId - The user's identity ID
   * @param userPrivKey - User's encryption private key (Uint8Array, 32 bytes)
   */
  async getDecryptedAddresses(userId: string, userPrivKey: Uint8Array): Promise<SavedAddress[]> {
    const doc = await this.getForUser(userId);
    if (!doc || doc.encryptedPayload.length === 0) {
      return [];
    }

    try {
      const aad = new TextEncoder().encode(AAD_SHIPPING);
      const decryptedBytes = await privateFeedCryptoService.eciesDecrypt(
        userPrivKey,
        doc.encryptedPayload,
        aad
      );

      const decoder = new TextDecoder();
      const payloadJson = decoder.decode(decryptedBytes);
      const payload = JSON.parse(payloadJson) as SavedAddressPayload;

      // Validate version
      if (payload.version !== PAYLOAD_VERSION) {
        console.warn(`Unknown saved address payload version: ${payload.version}`);
      }

      return payload.addresses || [];
    } catch (error) {
      console.error('Failed to decrypt saved addresses:', error);
      throw new Error('Failed to decrypt saved addresses. Your encryption key may have changed.');
    }
  }

  /**
   * Save all addresses (encrypts and stores)
   * @param userId - The user's identity ID
   * @param addresses - Array of saved addresses to store
   * @param userPubKey - User's encryption public key (Uint8Array, 33 bytes compressed)
   */
  async saveAddresses(userId: string, addresses: SavedAddress[], userPubKey: Uint8Array): Promise<void> {
    const payload: SavedAddressPayload = {
      version: PAYLOAD_VERSION,
      addresses
    };

    const payloadJson = JSON.stringify(payload);
    const payloadBytes = new TextEncoder().encode(payloadJson);
    const aad = new TextEncoder().encode(AAD_SHIPPING);

    // Encrypt with ECIES
    const encryptedPayload = await privateFeedCryptoService.eciesEncrypt(
      userPubKey,
      payloadBytes,
      aad
    );

    // Check if document already exists
    const existingDoc = await this.getForUser(userId);

    if (existingDoc) {
      // Update existing document
      await this.update(existingDoc.id, userId, {
        encryptedPayload: Array.from(encryptedPayload)
      });
    } else {
      // Create new document
      await this.create(userId, {
        encryptedPayload: Array.from(encryptedPayload)
      });
    }
  }

  /**
   * Add a new address
   * @param userId - The user's identity ID
   * @param address - Shipping address to save
   * @param contact - Contact info to save
   * @param label - Label for the address (e.g., "Home", "Work")
   * @param userPubKey - User's encryption public key
   * @param userPrivKey - User's encryption private key (to decrypt existing)
   * @param isDefault - Whether this should be the default address
   */
  async addAddress(
    userId: string,
    address: ShippingAddress,
    contact: BuyerContact,
    label: string,
    userPubKey: Uint8Array,
    userPrivKey: Uint8Array,
    isDefault?: boolean
  ): Promise<SavedAddress> {
    // Get existing addresses
    const existingAddresses = await this.getDecryptedAddresses(userId, userPrivKey).catch(() => []);

    // Create new address
    const newAddress: SavedAddress = {
      id: generateUUID(),
      label,
      address,
      contact,
      isDefault: isDefault || existingAddresses.length === 0, // First address is default
      createdAt: Date.now()
    };

    // If new address is default, clear default from others
    let updatedAddresses: SavedAddress[];
    if (newAddress.isDefault) {
      updatedAddresses = existingAddresses.map(a => ({ ...a, isDefault: false }));
    } else {
      updatedAddresses = [...existingAddresses];
    }
    updatedAddresses.push(newAddress);

    // Save all
    await this.saveAddresses(userId, updatedAddresses, userPubKey);

    return newAddress;
  }

  /**
   * Remove an address by ID
   */
  async removeAddress(
    userId: string,
    addressId: string,
    userPubKey: Uint8Array,
    userPrivKey: Uint8Array
  ): Promise<boolean> {
    const addresses = await this.getDecryptedAddresses(userId, userPrivKey);
    const filtered = addresses.filter(a => a.id !== addressId);

    if (filtered.length === addresses.length) {
      return false; // Address not found
    }

    // If we removed the default, make the first remaining one default
    const hadDefault = addresses.find(a => a.id === addressId)?.isDefault;
    if (hadDefault && filtered.length > 0) {
      filtered[0].isDefault = true;
    }

    await this.saveAddresses(userId, filtered, userPubKey);
    return true;
  }

  /**
   * Update an address
   */
  async updateAddress(
    userId: string,
    addressId: string,
    updates: Partial<Pick<SavedAddress, 'label' | 'address' | 'contact' | 'isDefault'>>,
    userPubKey: Uint8Array,
    userPrivKey: Uint8Array
  ): Promise<SavedAddress | null> {
    const addresses = await this.getDecryptedAddresses(userId, userPrivKey);
    const index = addresses.findIndex(a => a.id === addressId);

    if (index === -1) {
      return null;
    }

    // Apply updates
    const updatedAddress = { ...addresses[index], ...updates };

    // If setting as default, clear default from others
    if (updates.isDefault) {
      addresses.forEach((a, i) => {
        if (i !== index) {
          a.isDefault = false;
        }
      });
    }

    addresses[index] = updatedAddress;
    await this.saveAddresses(userId, addresses, userPubKey);

    return updatedAddress;
  }

  /**
   * Set an address as the default
   */
  async setDefault(
    userId: string,
    addressId: string,
    userPubKey: Uint8Array,
    userPrivKey: Uint8Array
  ): Promise<boolean> {
    const result = await this.updateAddress(userId, addressId, { isDefault: true }, userPubKey, userPrivKey);
    return result !== null;
  }

  /**
   * Get the default address
   */
  getDefaultAddress(addresses: SavedAddress[]): SavedAddress | undefined {
    return addresses.find(a => a.isDefault) || addresses[0];
  }
}

export const savedAddressService = new SavedAddressService();
