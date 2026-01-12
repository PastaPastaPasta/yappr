import { BaseDocumentService, QueryOptions } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { dpnsService } from './dpns-service';
import { cacheManager } from '../cache-manager';
import { YAPPR_PROFILE_CONTRACT_ID } from '../constants';
import { User, ParsedPaymentUri, SocialLink } from '../types';

// Approved payment URI schemes (whitelist)
export const APPROVED_PAYMENT_SCHEMES = [
  'dash:',           // Dash
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
  $updatedAt: number;
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
  private readonly USERNAME_CACHE = 'usernames';
  private readonly AVATAR_CACHE = 'avatars';

  // DataLoader-style batching for avatar URLs
  private pendingAvatarRequests = new Map<string, {
    resolvers: Array<(url: string) => void>;
  }>();
  private batchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super('profile', YAPPR_PROFILE_CONTRACT_ID);
  }

  // ==================== Avatar URL Helpers ====================

  /**
   * Generate DiceBear avatar URL from config
   */
  getAvatarUrlFromConfig(config: AvatarConfig): string {
    if (!config.seed) {
      console.warn('UnifiedProfileService: getAvatarUrlFromConfig called with empty seed');
      return '';
    }
    return `https://api.dicebear.com/7.x/${config.style}/svg?seed=${encodeURIComponent(config.seed)}`;
  }

  /**
   * Get default avatar URL using user ID as seed
   */
  getDefaultAvatarUrl(userId: string): string {
    if (!userId) {
      console.warn('UnifiedProfileService: getDefaultAvatarUrl called with empty userId');
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

  // ==================== Batching for Avatar URLs ====================

  /**
   * Schedule batch processing with debounce
   */
  private scheduleBatch() {
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
    }
    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null;
      this.processBatch();
    }, 5);
  }

  /**
   * Process all pending avatar requests in a single batch query
   */
  private async processBatch() {
    const batch = new Map(this.pendingAvatarRequests);
    this.pendingAvatarRequests.clear();

    if (batch.size === 0) return;

    const userIds = Array.from(batch.keys());

    try {
      const results = await this.fetchAvatarUrlsBatch(userIds);

      Array.from(batch.entries()).forEach(([userId, { resolvers }]) => {
        const url = results.get(userId) || this.getDefaultAvatarUrl(userId);
        resolvers.forEach(resolve => resolve(url));
      });
    } catch (error) {
      // On error, resolve with defaults
      Array.from(batch.entries()).forEach(([userId, { resolvers }]) => {
        const url = this.getDefaultAvatarUrl(userId);
        resolvers.forEach(resolve => resolve(url));
      });
    }
  }

  /**
   * Get avatar URL for a user with DataLoader-style batching
   */
  async getAvatarUrl(ownerId: string): Promise<string> {
    if (!ownerId) {
      console.warn('UnifiedProfileService: getAvatarUrl called with empty ownerId');
      return '';
    }

    // Check cache first
    const cached = cacheManager.get<string>(this.AVATAR_CACHE, ownerId);
    if (cached) {
      return cached;
    }

    // Add to pending batch and return promise
    return new Promise((resolve) => {
      const existing = this.pendingAvatarRequests.get(ownerId);
      if (existing) {
        existing.resolvers.push(resolve);
      } else {
        this.pendingAvatarRequests.set(ownerId, { resolvers: [resolve] });
      }
      this.scheduleBatch();
    });
  }

  /**
   * Batch fetch avatar URLs for multiple users
   */
  private async fetchAvatarUrlsBatch(userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    try {
      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'profile',
        where: [['$ownerId', 'in', userIds]],
        orderBy: [['$ownerId', 'asc']],
        limit: userIds.length
      } as any);

      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      }

      const foundUserIds = new Set<string>();
      for (const doc of documents) {
        const profileDoc = this.extractDocumentData(doc);
        const avatarUrl = this.parseAvatarField(profileDoc.avatar, profileDoc.$ownerId);

        result.set(profileDoc.$ownerId, avatarUrl);
        foundUserIds.add(profileDoc.$ownerId);

        // Cache for future use
        cacheManager.set(this.AVATAR_CACHE, profileDoc.$ownerId, avatarUrl, {
          ttl: 300000, // 5 minutes
          tags: ['avatar', `user:${profileDoc.$ownerId}`],
        });
      }

      // For users without profiles, use default
      for (const userId of userIds) {
        if (!foundUserIds.has(userId)) {
          result.set(userId, this.getDefaultAvatarUrl(userId));
        }
      }
    } catch (error) {
      console.error('UnifiedProfileService: Error getting batch avatar URLs:', error);
      for (const userId of userIds) {
        if (!result.has(userId)) {
          result.set(userId, this.getDefaultAvatarUrl(userId));
        }
      }
    }

    return result;
  }

  // ==================== Payment URI Helpers ====================

  /**
   * Parse payment URIs from JSON string and filter to approved schemes
   */
  parsePaymentUris(paymentUrisJson: string | undefined): ParsedPaymentUri[] {
    if (!paymentUrisJson) return [];

    try {
      const uris: string[] = JSON.parse(paymentUrisJson);
      return uris
        .filter(uri => this.isApprovedPaymentScheme(uri))
        .map(uri => ({
          scheme: this.extractScheme(uri),
          uri,
        }));
    } catch {
      return [];
    }
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
    if (!socialLinksJson) return [];

    try {
      return JSON.parse(socialLinksJson);
    } catch {
      return [];
    }
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
  private extractDocumentData(doc: any): UnifiedProfileDocument {
    const isNestedFormat = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data);
    const content = isNestedFormat ? doc.data : doc;

    return {
      $id: doc.$id || doc.id,
      $ownerId: doc.$ownerId || doc.ownerId,
      $createdAt: doc.$createdAt || doc.createdAt,
      $updatedAt: doc.$updatedAt || doc.updatedAt,
      $revision: doc.$revision || doc.revision,
      displayName: content.displayName || '',
      bio: content.bio,
      location: content.location,
      website: content.website,
      bannerUri: content.bannerUri,
      avatar: content.avatar,
      paymentUris: content.paymentUris,
      pronouns: content.pronouns,
      nsfw: content.nsfw,
      socialLinks: content.socialLinks,
    };
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
      hasUnifiedProfile: true,
    };

    // Queue async enrichment
    this.enrichUser(user, !!cachedUsername);

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
      console.error('UnifiedProfileService: Error enriching user:', error);
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
      console.error('UnifiedProfileService: Error resolving username:', error);
      return null;
    }
  }

  /**
   * Get user statistics
   */
  private async getUserStats(userId: string): Promise<{ followers: number; following: number }> {
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

      const result = await this.query({
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      });

      if (result.documents.length > 0) {
        const profile = result.documents[0];
        if (cachedUsername) {
          profile.username = cachedUsername;
        }

        cacheManager.set(this.PROFILE_CACHE, ownerId, profile, {
          ttl: 300000,
          tags: ['profile', `user:${ownerId}`]
        });

        return profile;
      }

      return null;
    } catch (error) {
      console.error('UnifiedProfileService: Error getting profile:', error);
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
      console.error('UnifiedProfileService: Error getting profile with username:', error);
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

      // Need to get raw profile document to preserve existing field values
      const rawProfile = await this.getRawProfile(ownerId);
      if (!rawProfile) {
        throw new Error('Profile not found');
      }

      // Build document data, preserving existing values for fields not being updated
      const documentData: Record<string, unknown> = {
        // displayName is required
        displayName: updates.displayName !== undefined
          ? updates.displayName.trim()
          : rawProfile.displayName,
      };

      // For each optional field: use update value if provided, otherwise preserve existing
      const bio = updates.bio !== undefined ? updates.bio.trim() : rawProfile.bio;
      if (bio) documentData.bio = bio;

      const location = updates.location !== undefined ? updates.location.trim() : rawProfile.location;
      if (location) documentData.location = location;

      const website = updates.website !== undefined ? updates.website.trim() : rawProfile.website;
      if (website) documentData.website = website;

      const bannerUri = updates.bannerUri !== undefined ? updates.bannerUri.trim() : rawProfile.bannerUri;
      if (bannerUri) documentData.bannerUri = bannerUri;

      // Avatar: preserve existing if not being updated
      const avatar = updates.avatar !== undefined ? updates.avatar : rawProfile.avatar;
      if (avatar) documentData.avatar = avatar;

      // PaymentUris: preserve existing if not being updated
      if (updates.paymentUris !== undefined) {
        if (updates.paymentUris.length > 0) {
          documentData.paymentUris = this.encodePaymentUris(updates.paymentUris);
        }
      } else if (rawProfile.paymentUris) {
        documentData.paymentUris = rawProfile.paymentUris;
      }

      const pronouns = updates.pronouns !== undefined ? updates.pronouns.trim() : rawProfile.pronouns;
      if (pronouns) documentData.pronouns = pronouns;

      // NSFW: preserve existing if not being updated
      if (updates.nsfw !== undefined) {
        documentData.nsfw = updates.nsfw;
      } else if (rawProfile.nsfw !== undefined) {
        documentData.nsfw = rawProfile.nsfw;
      }

      // SocialLinks: preserve existing if not being updated
      if (updates.socialLinks !== undefined) {
        if (updates.socialLinks.length > 0) {
          documentData.socialLinks = this.encodeSocialLinks(updates.socialLinks);
        }
      } else if (rawProfile.socialLinks) {
        documentData.socialLinks = rawProfile.socialLinks;
      }

      const docId = rawProfile.$id;
      if (!docId) {
        throw new Error('Profile document ID not found');
      }

      const result = await this.update(docId, ownerId, documentData);
      cacheManager.invalidateByTag(`user:${ownerId}`);
      return result;
    } catch (error) {
      console.error('UnifiedProfileService: Error updating profile:', error);
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
      } as any);

      let documents: any[] = [];
      if (response instanceof Map) {
        documents = Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
      } else if (Array.isArray(response)) {
        documents = response;
      } else if (response && (response as any).documents) {
        documents = (response as any).documents;
      }

      if (documents.length === 0) {
        return null;
      }

      return this.extractDocumentData(documents[0]);
    } catch (error) {
      console.error('UnifiedProfileService: Error getting raw profile:', error);
      return null;
    }
  }

  /**
   * Get profiles by array of identity IDs (batch)
   */
  async getProfilesByIdentityIds(identityIds: string[]): Promise<UnifiedProfileDocument[]> {
    try {
      if (identityIds.length === 0) return [];

      const bs58 = (await import('bs58')).default;
      const validIds = identityIds.filter(id => {
        if (!id || id === 'unknown') return false;
        try {
          const decoded = bs58.decode(id);
          return decoded.length === 32;
        } catch {
          return false;
        }
      });

      if (validIds.length === 0) return [];

      const { getEvoSdk } = await import('./evo-sdk-service');
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [['$ownerId', 'in', validIds]],
        orderBy: [['$ownerId', 'asc']],
        limit: 100
      } as any);

      if (response instanceof Map) {
        return Array.from(response.values())
          .filter(Boolean)
          .map((doc: any) => this.extractDocumentData(
            typeof doc.toJSON === 'function' ? doc.toJSON() : doc
          ));
      }

      const anyResponse = response as any;
      if (Array.isArray(anyResponse)) {
        return anyResponse.map(doc => this.extractDocumentData(doc));
      } else if (anyResponse?.documents) {
        return anyResponse.documents.map((doc: any) => this.extractDocumentData(doc));
      }

      return [];
    } catch (error) {
      console.error('UnifiedProfileService: Error getting profiles by identity IDs:', error);
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
