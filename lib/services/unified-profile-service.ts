import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { dpnsService } from './dpns-service';
import { cacheManager } from '../cache-manager';
import { YAPPR_PROFILE_CONTRACT_ID } from '../constants';
import { User, ParsedPaymentUri, SocialLink } from '../../types';
import { generateAvatarDataUri } from './avatar-generator';
import { documentToPlainObject } from './sdk-helpers';

// Approved payment URI schemes (whitelist)
export const APPROVED_PAYMENT_SCHEMES = [
  'dash:',           // Dash
  'tdash:',          // Dash (Testnet)
  'bitcoin:',        // Bitcoin
  'litecoin:',       // Litecoin
  'ethereum:',       // Ethereum
  'monero:',         // Monero
  'dogecoin:',       // Dogecoin
  'bitcoincash:',    // Bitcoin Cash
  'zcash:',          // Zcash
  'stellar:',        // Stellar (XLM)
  'ripple:',         // XRP
  'solana:',         // Solana
  'cardano:',        // Cardano (ADA)
  'polkadot:',       // Polkadot (DOT)
  'tron:',           // Tron (TRX)
  'lightning:',      // Bitcoin Lightning Network
] as const;

// DiceBear styles (ported from avatar-utils)
export const DICEBEAR_STYLES = [
  'adventurer', 'adventurer-neutral', 'avataaars', 'avataaars-neutral',
  'big-ears', 'big-ears-neutral', 'big-smile', 'bottts', 'bottts-neutral',
  'croodles', 'croodles-neutral', 'fun-emoji', 'icons', 'identicon',
  'initials', 'lorelei', 'lorelei-neutral', 'micah', 'miniavs',
  'notionists', 'notionists-neutral', 'open-peeps', 'personas',
  'pixel-art', 'pixel-art-neutral', 'rings', 'shapes', 'thumbs',
] as const;

export type DiceBearStyle = typeof DICEBEAR_STYLES[number];

export const DEFAULT_AVATAR_STYLE: DiceBearStyle = 'thumbs';

// Human-readable labels for DiceBear styles
export const DICEBEAR_STYLE_LABELS: Record<DiceBearStyle, string> = {
  'adventurer': 'Adventurer',
  'adventurer-neutral': 'Adventurer Neutral',
  'avataaars': 'Avataaars',
  'avataaars-neutral': 'Avataaars Neutral',
  'big-ears': 'Big Ears',
  'big-ears-neutral': 'Big Ears Neutral',
  'big-smile': 'Big Smile',
  'bottts': 'Bottts',
  'bottts-neutral': 'Bottts Neutral',
  'croodles': 'Croodles',
  'croodles-neutral': 'Croodles Neutral',
  'fun-emoji': 'Fun Emoji',
  'icons': 'Icons',
  'identicon': 'Identicon',
  'initials': 'Initials',
  'lorelei': 'Lorelei',
  'lorelei-neutral': 'Lorelei Neutral',
  'micah': 'Micah',
  'miniavs': 'Miniavs',
  'notionists': 'Notionists',
  'notionists-neutral': 'Notionists Neutral',
  'open-peeps': 'Open Peeps',
  'personas': 'Personas',
  'pixel-art': 'Pixel Art',
  'pixel-art-neutral': 'Pixel Art Neutral',
  'rings': 'Rings',
  'shapes': 'Shapes',
  'thumbs': 'Thumbs',
};

// Raw document from the unified profile contract
export interface UnifiedProfileDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  displayName: string;
  bio?: string;
  location?: string;
  website?: string;
  bannerUri?: string;
  avatar?: string;       // JSON string or URI
  paymentUris?: string;  // JSON array string
  pronouns?: string;
  nsfw?: boolean;
  socialLinks?: string;  // JSON array string
}

// Data for creating a profile
export interface CreateUnifiedProfileData {
  displayName: string;
  bio?: string;
  location?: string;
  website?: string;
  bannerUri?: string;
  avatar?: string;
  paymentUris?: string[];
  pronouns?: string;
  nsfw?: boolean;
  socialLinks?: SocialLink[];
}

// Data for updating a profile
export interface UpdateUnifiedProfileData {
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  bannerUri?: string;
  avatar?: string;
  paymentUris?: string[];
  pronouns?: string;
  nsfw?: boolean;
  socialLinks?: SocialLink[];
}

// Avatar configuration
export interface AvatarConfig {
  style: DiceBearStyle;
  seed: string;
}

class UnifiedProfileService extends BaseDocumentService<User> {
  private readonly PROFILE_CACHE = 'unified_profiles';
  private readonly RAW_PROFILE_CACHE = 'unified_profiles_raw';
  private readonly MISSING_PROFILE_CACHE = 'unified_profiles_missing';
  private readonly USERNAME_CACHE = 'usernames';
  private readonly AVATAR_CACHE = 'avatars';

  // DataLoader-style batching for raw profile documents: every profile
  // lookup (getProfile, getProfilesByIdentityIds, avatar URLs) funnels
  // through loadProfileDoc so concurrent requests share one 'in' query.
  private pendingProfileRequests = new Map<string, Array<(doc: UnifiedProfileDocument | null) => void>>();
  private batchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super('profile', YAPPR_PROFILE_CONTRACT_ID);
  }

  // ==================== Avatar URL Helpers ====================

  /**
   * Generate DiceBear avatar data URI from config (local generation)
   */
  getAvatarUrlFromConfig(config: AvatarConfig): string {
    if (!config.seed) {
      logger.warn('UnifiedProfileService: getAvatarUrlFromConfig called with empty seed');
      return '';
    }
    return generateAvatarDataUri(config.style, config.seed);
  }

  /**
   * Get default avatar URL using user ID as seed
   */
  getDefaultAvatarUrl(userId: string): string {
    if (!userId) {
      logger.warn('UnifiedProfileService: getDefaultAvatarUrl called with empty userId');
      return '';
    }
    return this.getAvatarUrlFromConfig({ style: DEFAULT_AVATAR_STYLE, seed: userId });
  }

  /**
   * Parse avatar field - can be DiceBear JSON or direct URI
   */
  parseAvatarField(avatarField: string | undefined, userId: string): string {
    if (!avatarField) {
      return this.getDefaultAvatarUrl(userId);
    }

    // Check if it's a direct URI (starts with http, https, or ipfs)
    if (avatarField.startsWith('http://') ||
        avatarField.startsWith('https://') ||
        avatarField.startsWith('ipfs://')) {
      return avatarField;
    }

    // Try to parse as DiceBear JSON
    try {
      const parsed = JSON.parse(avatarField);
      if (parsed.style && parsed.seed) {
        const style = DICEBEAR_STYLES.includes(parsed.style) ? parsed.style : DEFAULT_AVATAR_STYLE;
        return this.getAvatarUrlFromConfig({ style, seed: parsed.seed });
      }
    } catch {
      // Not JSON, treat as seed only
    }

    // Fallback to treating the field as a seed
    return this.getAvatarUrlFromConfig({ style: DEFAULT_AVATAR_STYLE, seed: avatarField });
  }

  /**
   * Encode avatar config to JSON string for storage
   */
  encodeAvatarData(seed: string, style: DiceBearStyle): string {
    return JSON.stringify({ seed, style });
  }

  /**
   * Generate a random seed string
   */
  generateRandomSeed(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  // ==================== Seeding from external lookups ====================

  /**
   * Seed the profile caches from documents fetched elsewhere (a composite
   * feed page carries the authors' profiles under the same proof as the
   * posts). Every id in `queriedOwnerIds` without a document is a PROVEN
   * absence and is negative-cached exactly as a batch miss would be, so
   * the DataLoader answers later lookups from cache. Returns the found
   * documents keyed by owner, with their avatar URLs already cached.
   */
  seedProfileDocuments(
    records: readonly Record<string, unknown>[],
    queriedOwnerIds: readonly string[]
  ): Map<string, UnifiedProfileDocument> {
    const found = new Map<string, UnifiedProfileDocument>();
    for (const record of records) {
      const profileDoc = this.extractDocumentData(record);
      if (!profileDoc.$ownerId) continue;
      found.set(profileDoc.$ownerId, profileDoc);
      cacheManager.set(this.RAW_PROFILE_CACHE, profileDoc.$ownerId, profileDoc, {
        ttl: 300000,
        tags: ['profile', `user:${profileDoc.$ownerId}`]
      });
      cacheManager.set(this.AVATAR_CACHE, profileDoc.$ownerId, this.parseAvatarField(profileDoc.avatar, profileDoc.$ownerId), {
        ttl: 300000,
        tags: ['avatar', `user:${profileDoc.$ownerId}`]
      });
    }
    for (const ownerId of queriedOwnerIds) {
      if (found.has(ownerId)) continue;
      cacheManager.set(this.MISSING_PROFILE_CACHE, ownerId, true, {
        ttl: 60000,
        tags: ['profile', `user:${ownerId}`]
      });
      cacheManager.set(this.AVATAR_CACHE, ownerId, this.getDefaultAvatarUrl(ownerId), {
        ttl: 300000,
        tags: ['avatar', `user:${ownerId}`]
      });
    }
    return found;
  }

  // ==================== Batching for Profile Documents ====================

  /**
   * Schedule batch processing with debounce
   */
  private scheduleBatch() {
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
    }
    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null;
      this.processProfileBatch().catch(err => logger.error('Failed to process profile batch:', err));
    }, 5);
  }

  /**
   * Load a raw profile document with DataLoader-style batching.
   * Concurrent requests within the batch window share a single 'in' query.
   * Found profiles are cached; misses are negative-cached briefly so users
   * without a profile document don't trigger a fresh query on every render.
   */
  private loadProfileDoc(ownerId: string): Promise<UnifiedProfileDocument | null> {
    const cached = cacheManager.get<UnifiedProfileDocument>(this.RAW_PROFILE_CACHE, ownerId);
    if (cached) {
      return Promise.resolve(cached);
    }
    if (cacheManager.get<boolean>(this.MISSING_PROFILE_CACHE, ownerId)) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const existing = this.pendingProfileRequests.get(ownerId);
      if (existing) {
        existing.push(resolve);
      } else {
        this.pendingProfileRequests.set(ownerId, [resolve]);
      }
      this.scheduleBatch();
    });
  }

  /**
   * Process all pending profile requests in batched 'in' queries
   *
   * TODO: The 'in' clause doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  private async processProfileBatch() {
    const batch = new Map(this.pendingProfileRequests);
    this.pendingProfileRequests.clear();

    if (batch.size === 0) return;

    const resolveId = (ownerId: string, doc: UnifiedProfileDocument | null) => {
      batch.get(ownerId)?.forEach(resolve => resolve(doc));
      batch.delete(ownerId);
    };

    try {
      // Filter out placeholder values like 'unknown' — only valid base58
      // identity IDs (32 bytes when decoded) can go into the query.
      const bs58 = (await import('bs58')).default;
      const validIds: string[] = [];
      for (const ownerId of Array.from(batch.keys())) {
        let valid = false;
        if (ownerId && ownerId !== 'unknown') {
          try {
            valid = bs58.decode(ownerId).length === 32;
          } catch {
            valid = false;
          }
        }
        if (valid) {
          validIds.push(ownerId);
        } else {
          // Invalid ids can never resolve — cache the miss so repeat
          // lookups don't re-enter the batch loop on every render
          cacheManager.set(this.MISSING_PROFILE_CACHE, ownerId, true, {
            ttl: 300000,
            tags: ['profile', `user:${ownerId}`]
          });
          resolveId(ownerId, null);
        }
      }
      if (validIds.length === 0) return;

      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      // DAPI caps 'in' clauses at 100 values per query
      for (let i = 0; i < validIds.length; i += 100) {
        const chunk = validIds.slice(i, i + 100);
        const found = new Map<string, UnifiedProfileDocument>();
        try {
          const response = await sdk.documents.query({
            dataContractId: this.contractId,
            documentTypeName: this.documentType,
            where: [['$ownerId', 'in', chunk]],
            orderBy: [['$ownerId', 'asc']],
            limit: chunk.length
          });

          for (const doc of this.normalizeDocumentResponse(response)) {
            const profileDoc = this.extractDocumentData(doc);
            found.set(profileDoc.$ownerId, profileDoc);
            cacheManager.set(this.RAW_PROFILE_CACHE, profileDoc.$ownerId, profileDoc, {
              ttl: 300000, // 5 minutes
              tags: ['profile', `user:${profileDoc.$ownerId}`]
            });
          }

          for (const ownerId of chunk) {
            if (!found.has(ownerId)) {
              cacheManager.set(this.MISSING_PROFILE_CACHE, ownerId, true, {
                ttl: 60000, // 1 minute — new profiles show up quickly
                tags: ['profile', `user:${ownerId}`]
              });
            }
          }
        } catch (error) {
          // Resolve this chunk with null (matching single-fetch error
          // behavior) but skip negative caching so the next request retries.
          logger.error('UnifiedProfileService: Error batch-fetching profiles:', error);
        }

        for (const ownerId of chunk) {
          resolveId(ownerId, found.get(ownerId) || null);
        }
      }
    } finally {
      // Safety net: never leave a caller hanging on an unexpected failure
      batch.forEach(resolvers => resolvers.forEach(resolve => resolve(null)));
    }
  }

  /**
   * Get avatar URL for a user, batched with all other profile lookups
   */
  async getAvatarUrl(ownerId: string): Promise<string> {
    if (!ownerId) {
      logger.warn('UnifiedProfileService: getAvatarUrl called with empty ownerId');
      return '';
    }

    // Check cache first
    const cached = cacheManager.get<string>(this.AVATAR_CACHE, ownerId);
    if (cached) {
      return cached;
    }

    const doc = await this.loadProfileDoc(ownerId);
    const url = doc
      ? this.parseAvatarField(doc.avatar, ownerId)
      : this.getDefaultAvatarUrl(ownerId);

    cacheManager.set(this.AVATAR_CACHE, ownerId, url, {
      ttl: 300000, // 5 minutes
      tags: ['avatar', `user:${ownerId}`],
    });

    return url;
  }

  // ==================== Payment URI Helpers ====================

  /**
   * Parse payment URIs from JSON string and filter to approved schemes
   */
  parsePaymentUris(paymentUrisJson: string | undefined): ParsedPaymentUri[] {
    const uris = this.parseJsonSafe<string[]>(paymentUrisJson, []);
    return uris
      .filter(uri => this.isApprovedPaymentScheme(uri))
      .map(uri => ({
        scheme: this.extractScheme(uri),
        uri,
      }));
  }

  /**
   * Check if a URI has an approved payment scheme
   */
  isApprovedPaymentScheme(uri: string): boolean {
    const lowerUri = uri.toLowerCase();
    return APPROVED_PAYMENT_SCHEMES.some(scheme => lowerUri.startsWith(scheme));
  }

  /**
   * Extract scheme from URI
   */
  private extractScheme(uri: string): string {
    const colonIndex = uri.indexOf(':');
    if (colonIndex > 0) {
      return uri.substring(0, colonIndex + 1).toLowerCase();
    }
    return '';
  }

  /**
   * Encode payment URIs to JSON string for storage
   */
  encodePaymentUris(uris: string[]): string {
    return JSON.stringify(uris);
  }

  // ==================== Social Links Helpers ====================

  /**
   * Parse social links from JSON string
   */
  parseSocialLinks(socialLinksJson: string | undefined): SocialLink[] {
    return this.parseJsonSafe<SocialLink[]>(socialLinksJson, []);
  }

  /**
   * Encode social links to JSON string for storage
   */
  encodeSocialLinks(links: SocialLink[]): string {
    return JSON.stringify(links);
  }

  // ==================== Document Transformation ====================

  /**
   * Extract raw document data handling SDK response formats
   */
  private extractDocumentData(doc: Record<string, unknown>): UnifiedProfileDocument {
    const isNestedFormat = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data);
    const content = (isNestedFormat ? doc.data : doc) as Record<string, unknown>;

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      $updatedAt: (doc.$updatedAt || doc.updatedAt) as number | undefined,
      $revision: (doc.$revision || doc.revision) as number | undefined,
      displayName: (content.displayName as string) || '',
      bio: content.bio as string | undefined,
      location: content.location as string | undefined,
      website: content.website as string | undefined,
      bannerUri: content.bannerUri as string | undefined,
      avatar: content.avatar as string | undefined,
      paymentUris: content.paymentUris as string | undefined,
      pronouns: content.pronouns as string | undefined,
      nsfw: content.nsfw as boolean | undefined,
      socialLinks: content.socialLinks as string | undefined,
    };
  }

  /**
   * Normalize SDK response to array of documents
   * Handles Map, Array, and {documents: []} response formats
   */
  private normalizeDocumentResponse(response: unknown): Record<string, unknown>[] {
    if (response instanceof Map) {
      return Array.from(response.values())
        .filter(Boolean)
        .map(documentToPlainObject);
    }
    if (Array.isArray(response)) {
      return response
        .filter(Boolean)
        .map(documentToPlainObject);
    }
    if (response && typeof response === 'object' && 'documents' in response) {
      return ((response as { documents: unknown[] }).documents || [])
        .filter(Boolean)
        .map(documentToPlainObject);
    }
    return [];
  }

  /**
   * Parse JSON string with fallback to default value
   */
  private parseJsonSafe<T>(json: string | undefined, defaultValue: T): T {
    if (!json) return defaultValue;
    try {
      return JSON.parse(json);
    } catch {
      return defaultValue;
    }
  }

  /**
   * Transform document to User type
   */
  protected transformDocument(doc: Record<string, unknown>, options?: Record<string, unknown>): User {
    const profileDoc = this.extractDocumentData(doc);
    const cachedUsername = options?.cachedUsername as string | undefined;
    const ownerIdStr = profileDoc.$ownerId || 'unknown';

    const user: User = {
      id: ownerIdStr,
      documentId: profileDoc.$id,
      $revision: profileDoc.$revision,
      username: cachedUsername || (ownerIdStr.substring(0, 8) + '...'),
      displayName: profileDoc.displayName || cachedUsername || (ownerIdStr.substring(0, 8) + '...'),
      avatar: this.parseAvatarField(profileDoc.avatar, ownerIdStr),
      bio: profileDoc.bio,
      location: profileDoc.location,
      website: profileDoc.website,
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date(profileDoc.$createdAt),
      // New unified profile fields
      bannerUri: profileDoc.bannerUri,
      paymentUris: this.parsePaymentUris(profileDoc.paymentUris),
      pronouns: profileDoc.pronouns,
      nsfw: profileDoc.nsfw,
      socialLinks: this.parseSocialLinks(profileDoc.socialLinks),
    };

    // Queue async enrichment
    this.enrichUser(user, !!cachedUsername).catch(err => logger.error('Failed to enrich user:', err));

    return user;
  }

  /**
   * Enrich user with async data (username, stats)
   */
  private async enrichUser(user: User, skipUsernameResolution?: boolean): Promise<void> {
    try {
      if (!skipUsernameResolution && user.username === user.id.substring(0, 8) + '...') {
        const username = await this.getUsername(user.id);
        if (username) {
          user.username = username;
        }
      }

      // Get follower/following counts (implementation in follow service)
      const stats = await this.getUserStats(user.id);
      user.followers = stats.followers;
      user.following = stats.following;
    } catch (error) {
      logger.error('UnifiedProfileService: Error enriching user:', error);
    }
  }

  /**
   * Get username from DPNS
   */
  private async getUsername(ownerId: string): Promise<string | null> {
    const cached = cacheManager.get<string>(this.USERNAME_CACHE, ownerId);
    if (cached) return cached;

    try {
      const username = await dpnsService.resolveUsername(ownerId);
      if (username) {
        cacheManager.set(this.USERNAME_CACHE, ownerId, username, {
          ttl: 300000,
          tags: ['username', `user:${ownerId}`]
        });
      }
      return username;
    } catch (error) {
      logger.error('UnifiedProfileService: Error resolving username:', error);
      return null;
    }
  }

  /**
   * Get user statistics
   */
  private async getUserStats(_userId: string): Promise<{ followers: number; following: number }> {
    // TODO: Query follow documents for actual counts
    return { followers: 0, following: 0 };
  }

  // ==================== Profile CRUD ====================

  /**
   * Get profile by owner ID
   */
  async getProfile(ownerId: string, cachedUsername?: string): Promise<User | null> {
    try {
      // Check cache first
      const cached = cacheManager.get<User>(this.PROFILE_CACHE, ownerId);
      if (cached) {
        if (cachedUsername && cached.username !== cachedUsername) {
          cached.username = cachedUsername;
        }
        return cached;
      }

      const doc = await this.loadProfileDoc(ownerId);
      if (!doc) {
        return null;
      }

      const profile = this.transformDocument(
        doc as unknown as Record<string, unknown>,
        cachedUsername ? { cachedUsername } : undefined
      );

      cacheManager.set(this.PROFILE_CACHE, ownerId, profile, {
        ttl: 300000,
        tags: ['profile', `user:${ownerId}`]
      });

      return profile;
    } catch (error) {
      logger.error('UnifiedProfileService: Error getting profile:', error);
      return null;
    }
  }

  /**
   * Get profile with username fully resolved
   */
  async getProfileWithUsername(ownerId: string): Promise<User | null> {
    try {
      const username = await this.getUsername(ownerId);
      const profile = await this.getProfile(ownerId, username || undefined);
      if (profile && username) {
        profile.username = username;
      }
      return profile;
    } catch (error) {
      logger.error('UnifiedProfileService: Error getting profile with username:', error);
      return this.getProfile(ownerId);
    }
  }

  /**
   * Get payment URIs for a user (filtered to approved schemes)
   */
  async getPaymentUris(ownerId: string): Promise<ParsedPaymentUri[]> {
    const profile = await this.getProfile(ownerId);
    return profile?.paymentUris || [];
  }

  /**
   * Create user profile
   */
  async createProfile(ownerId: string, data: CreateUnifiedProfileData): Promise<User> {
    const documentData: Record<string, unknown> = {
      displayName: data.displayName,
    };

    if (data.bio) documentData.bio = data.bio;
    if (data.location) documentData.location = data.location;
    if (data.website) documentData.website = data.website;
    if (data.bannerUri) documentData.bannerUri = data.bannerUri;
    if (data.avatar) documentData.avatar = data.avatar;
    if (data.paymentUris && data.paymentUris.length > 0) {
      documentData.paymentUris = this.encodePaymentUris(data.paymentUris);
    }
    if (data.pronouns) documentData.pronouns = data.pronouns;
    if (data.nsfw !== undefined) documentData.nsfw = data.nsfw;
    if (data.socialLinks && data.socialLinks.length > 0) {
      documentData.socialLinks = this.encodeSocialLinks(data.socialLinks);
    }

    const result = await this.create(ownerId, documentData);
    cacheManager.invalidateByTag(`user:${ownerId}`);
    return result;
  }

  /**
   * Update user profile
   * Note: We must include ALL fields in the update to preserve existing values,
   * as Dash Platform document updates replace the entire document.
   */
  async updateProfile(ownerId: string, updates: UpdateUnifiedProfileData): Promise<User | null> {
    try {
      cacheManager.invalidateByTag(`user:${ownerId}`);

      const rawProfile = await this.getRawProfile(ownerId);
      if (!rawProfile) {
        throw new Error('Profile not found');
      }

      const docId = rawProfile.$id;
      if (!docId) {
        throw new Error('Profile document ID not found');
      }

      // Helper to merge update with existing value, optionally trimming strings
      const mergeField = (
        updateVal: string | undefined,
        existingVal: string | undefined,
        trim = true
      ): string | undefined => {
        if (updateVal !== undefined) {
          return trim ? updateVal.trim() : updateVal;
        }
        return existingVal;
      };

      // Build document data, preserving existing values for fields not being updated
      const documentData: Record<string, unknown> = {
        displayName: mergeField(updates.displayName, rawProfile.displayName) || rawProfile.displayName,
      };

      // String fields with trim
      const stringFields = ['bio', 'location', 'website', 'bannerUri', 'pronouns'] as const;
      for (const field of stringFields) {
        const value = mergeField(updates[field], rawProfile[field]);
        if (value) {
          documentData[field] = value;
        }
      }

      // Avatar (no trim)
      const avatar = mergeField(updates.avatar, rawProfile.avatar, false);
      if (avatar) {
        documentData.avatar = avatar;
      }

      // PaymentUris: encode if updating, preserve raw if existing
      if (updates.paymentUris !== undefined) {
        if (updates.paymentUris.length > 0) {
          documentData.paymentUris = this.encodePaymentUris(updates.paymentUris);
        }
      } else if (rawProfile.paymentUris) {
        documentData.paymentUris = rawProfile.paymentUris;
      }

      // NSFW: boolean field
      if (updates.nsfw !== undefined) {
        documentData.nsfw = updates.nsfw;
      } else if (rawProfile.nsfw !== undefined) {
        documentData.nsfw = rawProfile.nsfw;
      }

      // SocialLinks: encode if updating, preserve raw if existing
      if (updates.socialLinks !== undefined) {
        if (updates.socialLinks.length > 0) {
          documentData.socialLinks = this.encodeSocialLinks(updates.socialLinks);
        }
      } else if (rawProfile.socialLinks) {
        documentData.socialLinks = rawProfile.socialLinks;
      }

      const result = await this.update(docId, ownerId, documentData);
      cacheManager.invalidateByTag(`user:${ownerId}`);
      return result;
    } catch (error) {
      logger.error('UnifiedProfileService: Error updating profile:', error);
      throw error;
    }
  }

  /**
   * Get raw profile document (not transformed to User type)
   * Used internally to preserve field values during updates
   */
  private async getRawProfile(ownerId: string): Promise<UnifiedProfileDocument | null> {
    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'profile',
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      });

      const documents = this.normalizeDocumentResponse(response);
      if (documents.length === 0) {
        return null;
      }

      return this.extractDocumentData(documents[0]);
    } catch (error) {
      logger.error('UnifiedProfileService: Error getting raw profile:', error);
      return null;
    }
  }

  /**
   * Get profiles by array of identity IDs (batch).
   * Rides the shared profile-document loader, so cached profiles are
   * reused and concurrent callers coalesce into a single 'in' query.
   * Result order follows the (deduplicated) input, NOT $ownerId order —
   * key results by $ownerId rather than relying on position.
   */
  async getProfilesByIdentityIds(identityIds: string[]): Promise<UnifiedProfileDocument[]> {
    try {
      if (identityIds.length === 0) return [];

      const uniqueIds = Array.from(new Set(identityIds));
      const docs = await Promise.all(uniqueIds.map(id => this.loadProfileDoc(id)));
      return docs.filter((doc): doc is UnifiedProfileDocument => doc !== null);
    } catch (error) {
      logger.error('UnifiedProfileService: Error getting profiles by identity IDs:', error);
      return [];
    }
  }

  /**
   * Batch get avatar URLs for multiple users
   */
  async getAvatarUrlsBatch(userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (userIds.length === 0) return result;

    const promises = userIds.filter(id => !!id).map(async (userId) => {
      const url = await this.getAvatarUrl(userId);
      result.set(userId, url);
    });

    await Promise.all(promises);
    return result;
  }
}

// Singleton instance
export const unifiedProfileService = new UnifiedProfileService();
