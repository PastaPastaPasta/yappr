import { logger } from '@/lib/logger';
/**
 * Dash Pay Contacts Service
 *
 * Queries the Dash Pay contract to find mutual contacts (users who have both
 * sent contact requests to each other). Compares with Yappr follows to identify
 * Dash Pay contacts the user isn't following on Yappr.
 */

import { getEvoSdk } from './evo-sdk-service';
import { queryDocuments, identifierToBase58 } from './sdk-helpers';
import { followService } from './follow-service';
import { dpnsService } from './dpns-service';
import { unifiedProfileService, UnifiedProfileDocument } from './unified-profile-service';
import { DASHPAY_CONTRACT_ID } from '../constants';
import bs58 from 'bs58';

// Raw contact request document from Dash Pay contract
export interface ContactRequestDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  toUserId: string; // base64 encoded 32-byte identifier
  encryptedPublicKey: string;
  senderKeyIndex: number;
  recipientKeyIndex: number;
  accountReference: number;
}

// Processed contact with user info
export interface DashPayContact {
  identityId: string;
  username?: string;
  displayName?: string;
  avatarUrl: string;
  isFollowedOnYappr: boolean;
  contactRequestDate: Date;
}

// Result of the unfollowed contacts check
export interface UnfollowedContactsResult {
  contacts: DashPayContact[];
  totalMutualContacts: number;
  alreadyFollowedCount: number;
}

class DashPayContactsService {
  private cache: Map<string, { data: UnfollowedContactsResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 300000; // 5 minutes

  /**
   * Convert base64 string to base58 for identifier consistency
   */
  private base64ToBase58(base64: string): string | null {
    try {
      let bytes: Uint8Array;
      if (typeof atob === 'function') {
        const binary = atob(base64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      } else {
        bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      }

      if (bytes.length === 32) {
        return bs58.encode(bytes);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Transform raw document to ContactRequestDocument
   */
  private transformDocument(doc: Record<string, unknown>): ContactRequestDocument {
    const data = (doc.data || doc) as Record<string, unknown>;

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      toUserId: data.toUserId as string,
      encryptedPublicKey: data.encryptedPublicKey as string,
      senderKeyIndex: data.senderKeyIndex as number,
      recipientKeyIndex: data.recipientKeyIndex as number,
      accountReference: data.accountReference as number,
    };
  }

  /**
   * Get all contact requests sent BY the user (outgoing)
   * Uses index: ownerIdCreatedAt
   */
  async getOutgoingContactRequests(userId: string): Promise<ContactRequestDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: DASHPAY_CONTRACT_ID,
        documentTypeName: 'contactRequest',
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });

      return documents.map(doc => this.transformDocument(doc));
    } catch (error) {
      logger.error('DashPayContactsService: Error fetching outgoing requests:', error);
      return [];
    }
  }

  /**
   * Get all contact requests sent TO the user (incoming)
   * Uses index: userIdCreatedAt
   * Note: toUserId is a 32-byte array field, requires byte array for query
   */
  async getIncomingContactRequests(userId: string): Promise<ContactRequestDocument[]> {
    try {
      const sdk = await getEvoSdk();

      // Convert userId from base58 to byte array for the query
      // toUserId is stored as a 32-byte array in the contract
      const userIdBytes = Array.from(bs58.decode(userId));

      const documents = await queryDocuments(sdk, {
        dataContractId: DASHPAY_CONTRACT_ID,
        documentTypeName: 'contactRequest',
        where: [['toUserId', '==', userIdBytes]],
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      });

      return documents.map(doc => this.transformDocument(doc));
    } catch (error) {
      logger.error('DashPayContactsService: Error fetching incoming requests:', error);
      return [];
    }
  }

  /**
   * Find mutual contacts - users where both parties have sent contact requests
   * Returns array of { identityId, contactDate } for mutual contacts
   */
  async getMutualContacts(userId: string): Promise<Array<{ identityId: string; contactDate: Date }>> {
    // Step 1: Get outgoing requests (people I sent requests to)
    const outgoing = await this.getOutgoingContactRequests(userId);

    // Extract toUserId from outgoing requests and convert to base58
    const outgoingSet = new Set<string>();
    const outgoingDates = new Map<string, number>();

    for (const req of outgoing) {
      // toUserId may be base64 or already converted
      const recipientId = identifierToBase58(req.toUserId);
      if (recipientId) {
        outgoingSet.add(recipientId);
        outgoingDates.set(recipientId, req.$createdAt);
      }
    }

    if (outgoingSet.size === 0) {
      logger.info('DashPayContactsService: No outgoing contact requests found');
      return [];
    }

    // Step 2: Get incoming requests (people who sent requests to me)
    const incoming = await this.getIncomingContactRequests(userId);

    // Map of sender ID -> request date
    const incomingMap = new Map<string, number>();
    for (const req of incoming) {
      if (req.$ownerId) {
        incomingMap.set(req.$ownerId, req.$createdAt);
      }
    }

    if (incomingMap.size === 0) {
      logger.info('DashPayContactsService: No incoming contact requests found');
      return [];
    }

    // Step 3: Find intersection - mutual contacts
    const mutualContacts: Array<{ identityId: string; contactDate: Date }> = [];

    Array.from(incomingMap.entries()).forEach(([senderId, incomingDate]) => {
      if (outgoingSet.has(senderId)) {
        // Mutual contact - use the later of the two dates as the "contact established" date
        const outgoingDate = outgoingDates.get(senderId) || 0;
        const contactDate = new Date(Math.max(incomingDate, outgoingDate));
        mutualContacts.push({ identityId: senderId, contactDate });
      }
    });

    logger.info(`DashPayContactsService: Found ${mutualContacts.length} mutual contacts`);
    return mutualContacts;
  }

  /**
   * Enrich a contact with user info (username, display name, avatar)
   */
  private async enrichContact(
    identityId: string,
    isFollowed: boolean,
    contactDate: Date
  ): Promise<DashPayContact> {
    const contact: DashPayContact = {
      identityId,
      avatarUrl: unifiedProfileService.getDefaultAvatarUrl(identityId),
      isFollowedOnYappr: isFollowed,
      contactRequestDate: contactDate
    };

    // These will be populated by batch operations in getUnfollowedContacts
    return contact;
  }

  /**
   * Get Dash Pay contacts that the user is not following on Yappr
   * Main entry point for the feature
   */
  async getUnfollowedContacts(userId: string): Promise<UnfollowedContactsResult> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.info('DashPayContactsService: Returning cached result');
      return cached.data;
    }

    try {
      // Get mutual contacts from Dash Pay
      const mutualContacts = await this.getMutualContacts(userId);

      if (mutualContacts.length === 0) {
        const result: UnfollowedContactsResult = {
          contacts: [],
          totalMutualContacts: 0,
          alreadyFollowedCount: 0
        };
        this.cache.set(userId, { data: result, timestamp: Date.now() });
        return result;
      }

      const mutualContactIds = mutualContacts.map(c => c.identityId);
      const contactDateMap = new Map(mutualContacts.map(c => [c.identityId, c.contactDate]));

      // Get current Yappr following list
      const followingIds = await followService.getFollowingIds(userId);
      const followingSet = new Set(followingIds);

      // Filter to unfollowed contacts
      const unfollowedIds = mutualContactIds.filter(id => !followingSet.has(id));

      if (unfollowedIds.length === 0) {
        const result: UnfollowedContactsResult = {
          contacts: [],
          totalMutualContacts: mutualContactIds.length,
          alreadyFollowedCount: mutualContactIds.length
        };
        this.cache.set(userId, { data: result, timestamp: Date.now() });
        return result;
      }

      // Batch resolve usernames and profiles in parallel
      const [usernameMap, profiles] = await Promise.all([
        dpnsService.resolveUsernamesBatch(unfollowedIds),
        unifiedProfileService.getProfilesByIdentityIds(unfollowedIds)
      ]);

      // Create profile lookup map
      const profileMap = new Map<string, UnifiedProfileDocument>();
      for (const profile of profiles) {
        const ownerId = profile.$ownerId;
        if (ownerId) {
          profileMap.set(ownerId, profile);
        }
      }

      // Build enriched contacts
      const contacts: DashPayContact[] = unfollowedIds.map(id => {
        const username = usernameMap.get(id) || undefined;
        const profile = profileMap.get(id);
        const displayName = profile?.displayName || undefined;
        const contactDate = contactDateMap.get(id) || new Date();

        return {
          identityId: id,
          username,
          displayName,
          avatarUrl: unifiedProfileService.getDefaultAvatarUrl(id),
          isFollowedOnYappr: false,
          contactRequestDate: contactDate
        };
      });

      const result: UnfollowedContactsResult = {
        contacts,
        totalMutualContacts: mutualContactIds.length,
        alreadyFollowedCount: mutualContactIds.length - unfollowedIds.length
      };

      // Cache the result
      this.cache.set(userId, { data: result, timestamp: Date.now() });

      logger.info(`DashPayContactsService: Found ${contacts.length} unfollowed contacts out of ${mutualContactIds.length} total`);
      return result;
    } catch (error) {
      logger.error('DashPayContactsService: Error getting unfollowed contacts:', error);
      throw error;
    }
  }

  /**
   * Clear cache for a user or all users
   */
  clearCache(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
    } else {
      this.cache.clear();
    }
  }
}

// Singleton instance
export const dashPayContactsService = new DashPayContactsService();
