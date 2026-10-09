import { logger } from '@/lib/logger';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { BaseDocumentService, withCreationTime } from './document-service';
import { dpnsService } from './dpns-service';
import { cacheManager } from '../cache-manager';
import { YAPPR_PROFILE_CONTRACT_ID, profileArraysAreTyped } from '../constants';
import { LIST_LIMITS, assertListLimits, decodePaymentUriList, decodeSocialLinkList, encodePaymentUriList, encodeSocialLinkList, socialLinkToString, uniqueStrings } from '../typed-array-codecs';
import { User, ParsedPaymentUri, SocialLink } from '../../types';
import { generateAvatarDataUri } from './avatar-generator';
import { documentToPlainObject } from './sdk-helpers';
import { stateTransitionService } from './state-transition-service';
import {
  avatarNeedingDigest,
  mergeV10ProfileRecords,
  planV10ProfileWrite,
  dashpayKeyBoundsRefusal,
  profileExtensionSource,
  profileSources,
  profileTextLimits,
  type ProfileRole,
  type ImageDigest,
  type ProfileSource,
  type V10ProfilePatch,
} from '../profile/v10-profile';

type PlainDocument = Record<string, unknown>;
/** One request for a profile document: its document (null: proved absent), or the failed query's error. */
type RoleWaiter = { resolve: (doc: PlainDocument | null) => void; reject: (error: unknown) => void };

/** A document's revision, as a read (`$revision`) or an older plain object (`revision`) carries it. */
function documentRevision(record: PlainDocument): number {
  return Number(record.$revision ?? record.revision ?? 0);
}

/** A document as its create wrote it: revision 1, which a create's result does not carry (a read-back's does). */
function asCreated(record: PlainDocument): PlainDocument {
  return record.$revision === undefined && record.revision === undefined ? { ...record, $revision: 1 } : record;
}

/** How long a save waits for a just-created DashPay profile before the extension (DAPI waits often time out). */
const DASHPAY_PROFILE_POLLS = 10;
const DASHPAY_PROFILE_POLL_MS = 2000;

/** The `scheme:` prefix of a payment URI, lower-cased; empty when there is none. */
export function paymentUriScheme(uri: string): string {
  const colonIndex = uri.indexOf(':');
  return colonIndex > 0 ? uri.substring(0, colonIndex + 1).toLowerCase() : '';
}

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
  /** profile v1: a JSON string of a list; profile v2: a typed list (docs/SOCIAL_V9.md). */
  paymentUris?: string | string[];
  pronouns?: string;
  nsfw?: boolean;
  /** profile v1: a JSON string of `{platform, handle}`; profile v2: a list of "platform:handle". */
  socialLinks?: string | string[];
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

/** `updateProfile`'s progress: the save is about to write document `step` of `total`. */
export interface ProfileSaveProgress {
  step: number;
  total: number;
}

export interface UpdateProfileOptions {
  /**
   * Called before each profile document is written. v10 writes the DashPay
   * profile and then the Yappr profile (each only when it changes), so a
   * save that changes both reports 1 of 2, then 2 of 2; v2 writes one
   * document and reports nothing.
   */
  onProgress?: (progress: ProfileSaveProgress) => void;
  /**
   * Called when a profile document was sent but its confirmation wait timed
   * out: the save may still land, or may never execute. Without it a
   * resolved save cannot be told from a confirmed one.
   */
  onUnconfirmed?: () => void;
}

// Avatar configuration
export interface AvatarConfig {
  style: DiceBearStyle;
  seed: string;
}

class UnifiedProfileService extends BaseDocumentService<User> {
  private readonly PROFILE_CACHE = 'unified_profiles';
  /** Per role, the raw documents found and the owners proved to have none. */
  private readonly ROLE_CACHES: Record<ProfileRole, { raw: string; missing: string }> = {
    base: { raw: 'unified_profiles_raw', missing: 'unified_profiles_missing' },
    extension: { raw: 'unified_profiles_extension_raw', missing: 'unified_profiles_extension_missing' },
  };
  private readonly USERNAME_CACHE = 'usernames';
  private readonly AVATAR_CACHE = 'avatars';
  /**
   * Profile documents this client wrote, by `role:ownerId`, for as long as a
   * cached read lives. DAPI answers a read from any node, and one a block
   * behind (or a read sent before the write landed) still returns the
   * previous revision: cached, that would show the old profile, and prefill
   * the next edit with it, until the cache expired. Until a read returns
   * this revision or a newer one, reads of an older one give way to it.
   */
  private readonly ownWrites = new Map<string, { record: PlainDocument; until: number }>();
  private readonly OWN_WRITE_TTL = 300000;

  // DataLoader-style batching for raw profile documents: every profile
  // lookup (getProfile, getProfilesByIdentityIds, avatar URLs) funnels
  // through loadProfileDoc so concurrent requests share one 'in' query per
  // profile document type. A waiter is answered with its document (null:
  // proved absent) or failed with the query's error.
  private pendingProfileRequests: Record<ProfileRole, Map<string, Array<RoleWaiter>>> = {
    base: new Map(),
    extension: new Map(),
  };
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

  // ==================== Profile document sources ====================

  private sourceFor(role: ProfileRole): ProfileSource {
    const found = profileSources().find((entry) => entry.role === role);
    if (!found) throw new Error(`No ${role} profile document on this contract topology`);
    return found.source;
  }

  /** The profile from cached documents: `known` once every role is cached (found or proved absent). */
  private profileFromCache(ownerId: string): { known: boolean; doc: UnifiedProfileDocument | null } {
    let known = true;
    const records: Partial<Record<ProfileRole, PlainDocument | null>> = {};
    for (const { role } of profileSources()) {
      const caches = this.ROLE_CACHES[role];
      const record = cacheManager.get<PlainDocument>(caches.raw, ownerId);
      if (record) records[role] = record;
      else if (cacheManager.get<boolean>(caches.missing, ownerId)) records[role] = null;
      else known = false;
    }
    return { known, doc: this.profileFromRecords(records.base ?? null, records.extension ?? null) };
  }

  /** One profile from its documents (v2/v9: the base alone). */
  private profileFromRecords(base: PlainDocument | null, extension: PlainDocument | null): UnifiedProfileDocument | null {
    const record = profileExtensionSource() ? mergeV10ProfileRecords(base, extension) : base;
    return record ? this.extractDocumentData(record) : null;
  }

  /**
   * What a read of `role` for `ownerId` stands for: the document read, or
   * this client's own write of it while the read is older (`ownWrites`).
   */
  private newestRecord(role: ProfileRole, ownerId: string, read: PlainDocument | null): PlainDocument | null {
    const key = `${role}:${ownerId}`;
    const own = this.ownWrites.get(key);
    if (!own) return read;
    if (own.until <= Date.now()) {
      this.ownWrites.delete(key);
      return read;
    }
    if (read && documentRevision(read) >= documentRevision(own.record)) {
      // Caught up (or passed: another device's edit). Keep the high-water mark
      // until it expires: the next read may come from a node still behind.
      own.record = read;
      return read;
    }
    return own.record;
  }

  /** Drops one cached document, or with no id everything cached, this client's own writes included. */
  override clearCache(documentId?: string): void {
    super.clearCache(documentId);
    if (!documentId) this.ownWrites.clear();
  }

  /** A profile document this client just wrote: cached, and preferred over older reads for a while. */
  private rememberWrite(role: ProfileRole, ownerId: string, record: PlainDocument): void {
    this.ownWrites.set(`${role}:${ownerId}`, { record, until: Date.now() + this.OWN_WRITE_TTL });
    this.storeRecord(role, ownerId, record);
  }

  /** Caches a document read (or this client's newer write of it, `newestRecord`); returns what was cached. */
  private cacheRecord(role: ProfileRole, ownerId: string, read: PlainDocument): PlainDocument {
    const record = this.newestRecord(role, ownerId, read) ?? read;
    this.storeRecord(role, ownerId, record);
    return record;
  }

  private storeRecord(role: ProfileRole, ownerId: string, record: PlainDocument): void {
    const caches = this.ROLE_CACHES[role];
    cacheManager.delete(caches.missing, ownerId);
    cacheManager.set(caches.raw, ownerId, record, {
      ttl: 300000, // 5 minutes
      tags: ['profile', `user:${ownerId}`]
    });
  }

  /**
   * Caches a read that found no document, unless this client has just
   * written one (a node behind has not seen it yet): then that is cached,
   * and returned.
   */
  private cacheMissing(role: ProfileRole, ownerId: string, ttl: number): PlainDocument | null {
    const own = this.newestRecord(role, ownerId, null);
    if (own) {
      this.storeRecord(role, ownerId, own);
      return own;
    }
    const caches = this.ROLE_CACHES[role];
    cacheManager.delete(caches.raw, ownerId);
    cacheManager.set(caches.missing, ownerId, true, {
      ttl,
      tags: ['profile', `user:${ownerId}`]
    });
    return null;
  }

  // ==================== Seeding from external lookups ====================

  /**
   * Seed the profile caches from documents of one profile role fetched
   * elsewhere (a composite feed page carries the authors' profiles under the
   * same proof as the posts). Every id in `queriedOwnerIds` without a document
   * is a PROVEN absence and is negative-cached exactly as a batch miss would
   * be, so the DataLoader answers later lookups from cache. Returns the found
   * profiles keyed by owner (on v10, merged with whatever of the other role is
   * cached), and caches the avatar URL of every owner whose profile is now
   * fully known.
   */
  seedProfileDocuments(
    records: readonly Record<string, unknown>[],
    queriedOwnerIds: readonly string[],
    role: ProfileRole = 'base'
  ): Map<string, UnifiedProfileDocument> {
    const found = new Map<string, UnifiedProfileDocument>();
    const seeded = new Set<string>();
    for (const record of records) {
      const ownerId = (record.$ownerId || record.ownerId) as string | undefined;
      if (!ownerId) continue;
      seeded.add(ownerId);
      this.cacheRecord(role, ownerId, record);
    }
    for (const ownerId of queriedOwnerIds) {
      if (!seeded.has(ownerId) && this.cacheMissing(role, ownerId, 60000)) seeded.add(ownerId);
    }
    for (const ownerId of new Set([...Array.from(seeded), ...queriedOwnerIds])) {
      const { known, doc } = this.profileFromCache(ownerId);
      if (doc && seeded.has(ownerId)) found.set(ownerId, doc);
      if (!known) continue;
      cacheManager.set(this.AVATAR_CACHE, ownerId, doc ? this.parseAvatarField(doc.avatar, ownerId) : this.getDefaultAvatarUrl(ownerId), {
        ttl: 300000,
        tags: ['avatar', `user:${ownerId}`]
      });
    }
    return found;
  }

  hasCachedProfile(ownerId: string): boolean {
    return this.profileFromCache(ownerId).known;
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
   * Load a user's profile document(s) with DataLoader-style batching and
   * merge them into one profile (v10: the DashPay profile and the extension).
   * Rejects when any role's read failed, so a profile missing one of its
   * documents is never merged, shown or cached as the whole profile.
   */
  private async loadProfileDoc(ownerId: string): Promise<UnifiedProfileDocument | null> {
    const roles = profileSources();
    const records = await Promise.all(roles.map(({ role }) => this.loadRoleRecord(role, ownerId)));
    // A save can land while the other role's query is still out: check every role against it again.
    const [base, extension] = roles.map(({ role }, index) => this.newestRecord(role, ownerId, records[index] ?? null));
    return this.profileFromRecords(base ?? null, extension ?? null);
  }

  /**
   * Load one raw profile document with DataLoader-style batching.
   * Concurrent requests within the batch window share a single 'in' query.
   * Found documents are cached; misses are negative-cached briefly so users
   * without a profile document don't trigger a fresh query on every render.
   * A failed query rejects, uncached, so the next request retries.
   */
  private loadRoleRecord(role: ProfileRole, ownerId: string): Promise<PlainDocument | null> {
    const caches = this.ROLE_CACHES[role];
    const cached = cacheManager.get<PlainDocument>(caches.raw, ownerId);
    if (cached) {
      return Promise.resolve(cached);
    }
    if (cacheManager.get<boolean>(caches.missing, ownerId)) {
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const pending = this.pendingProfileRequests[role];
      const waiter = { resolve, reject };
      const existing = pending.get(ownerId);
      if (existing) {
        existing.push(waiter);
      } else {
        pending.set(ownerId, [waiter]);
      }
      this.scheduleBatch();
    });
  }

  private async processProfileBatch() {
    // One SDK handle for every document type's batch, fetched only if one queries.
    let sdk: Promise<EvoSDK> | undefined;
    const getSdk = () => (sdk ??= import('./evo-sdk-service').then(({ getEvoSdk }) => getEvoSdk()));
    await Promise.all(profileSources().map(({ role, source }) => this.processRoleBatch(role, source, getSdk)));
  }

  /**
   * Process all pending requests for one profile document type in batched 'in' queries
   *
   * TODO: The 'in' clause doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  private async processRoleBatch(role: ProfileRole, source: ProfileSource, getSdk: () => Promise<EvoSDK>) {
    const batch = new Map(this.pendingProfileRequests[role]);
    this.pendingProfileRequests[role].clear();

    if (batch.size === 0) return;

    const resolveId = (ownerId: string, doc: PlainDocument | null) => {
      batch.get(ownerId)?.forEach(waiter => waiter.resolve(doc));
      batch.delete(ownerId);
    };
    const failId = (ownerId: string, error: unknown) => {
      batch.get(ownerId)?.forEach(waiter => waiter.reject(error));
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
          this.cacheMissing(role, ownerId, 300000);
          resolveId(ownerId, null);
        }
      }
      if (validIds.length === 0) return;

      const sdk = await getSdk();

      // DAPI caps 'in' clauses at 100 values per query
      for (let i = 0; i < validIds.length; i += 100) {
        const chunk = validIds.slice(i, i + 100);
        const found = new Map<string, PlainDocument>();
        let failure: { error: unknown } | null = null;
        try {
          const response = await sdk.documents.query({
            dataContractId: source.contractId,
            documentTypeName: source.documentType,
            where: [['$ownerId', 'in', chunk]],
            orderBy: [['$ownerId', 'asc']],
            limit: chunk.length
          });

          for (const doc of this.normalizeDocumentResponse(response)) {
            const ownerId = (doc.$ownerId || doc.ownerId) as string;
            found.set(ownerId, this.cacheRecord(role, ownerId, doc));
          }

          for (const ownerId of chunk) {
            if (!found.has(ownerId)) {
              const own = this.cacheMissing(role, ownerId, 60000); // 1 minute — new profiles show up quickly
              if (own) found.set(ownerId, own);
            }
          }
        } catch (error) {
          // Fail this chunk's waiters, uncached, so the next request retries:
          // a failed read is not a missing profile.
          logger.error('UnifiedProfileService: Error batch-fetching profiles:', error);
          failure = { error };
        }

        for (const ownerId of chunk) {
          if (failure) failId(ownerId, failure.error);
          else resolveId(ownerId, found.get(ownerId) || null);
        }
      }
    } catch (error) {
      // An unexpected failure (the SDK never loaded): every waiter left fails.
      Array.from(batch.keys()).forEach(ownerId => failId(ownerId, error));
    } finally {
      // Safety net: never leave a caller hanging.
      const unanswered = new Error('Profile read was not answered');
      Array.from(batch.keys()).forEach(ownerId => failId(ownerId, unanswered));
    }
  }

  /** Return the stored avatar recipe or custom URI without rendering it. */
  async getStoredAvatar(ownerId: string): Promise<string | undefined> {
    if (!ownerId) return undefined;
    return (await this.loadProfileDoc(ownerId))?.avatar;
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

    let doc: UnifiedProfileDocument | null;
    try {
      doc = await this.loadProfileDoc(ownerId);
    } catch {
      // A failed read (logged by the batch) shows the default avatar this once, uncached, so the next request retries.
      return this.getDefaultAvatarUrl(ownerId);
    }
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
   * Parse stored payment URIs (a list on profile v2, a JSON string on v1) and
   * filter to approved schemes.
   */
  parsePaymentUris(stored: unknown): ParsedPaymentUri[] {
    return decodePaymentUriList(stored)
      .filter(uri => this.isApprovedPaymentScheme(uri))
      .map(uri => ({
        scheme: paymentUriScheme(uri),
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
   * Payment URIs as the configured profile cut stores them (a list on v2, JSON
   * on v1). Profile v2 bounds the list (16 URIs of at most 512 characters,
   * scheme:address) and refuses one past that after signing, so it throws a
   * {@link ListLimitError} with a user-facing message first.
   */
  encodePaymentUris(uris: string[]): string | string[] {
    const typed = profileArraysAreTyped();
    if (typed) assertListLimits(uniqueStrings(uris), LIST_LIMITS.profilePaymentUris);
    return encodePaymentUriList(uris, typed);
  }

  // ==================== Social Links Helpers ====================

  /**
   * Parse stored social links: "platform:handle" strings on profile v2 (split
   * on the FIRST colon, since a handle may be a URL), a JSON string of
   * `{platform, handle}` on v1.
   */
  parseSocialLinks(stored: unknown): SocialLink[] {
    return decodeSocialLinkList(stored);
  }

  /**
   * Social links as the configured profile cut stores them. On profile v2 each
   * is ONE string "platform:handle" of at most 256 characters, the platform
   * prefix included, and at most 16 of them; checked before signing.
   */
  encodeSocialLinks(links: SocialLink[]): string | string[] {
    const typed = profileArraysAreTyped();
    const encoded = encodeSocialLinkList(links, typed);
    if (typed) assertListLimits(encoded as string[], LIST_LIMITS.profileSocialLinks);
    return encoded;
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
      paymentUris: content.paymentUris as string | string[] | undefined,
      pronouns: content.pronouns as string | undefined,
      nsfw: content.nsfw as boolean | undefined,
      socialLinks: content.socialLinks as string | string[] | undefined,
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
  async createProfile(ownerId: string, data: CreateUnifiedProfileData, options: UpdateProfileOptions = {}): Promise<User> {
    if (profileExtensionSource()) {
      return this.saveV10Profile(ownerId, data, options);
    }

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

    const startedAt = Date.now();
    const result = await stateTransitionService.createDocument(this.contractId, this.documentType, ownerId, documentData);
    if (!result.success || !result.document) {
      throw new Error(result.error || 'Failed to create profile');
    }
    // The inherited cache only: other owners' landed writes (another account on this device) keep their guard.
    super.clearCache();
    cacheManager.invalidateByTag(`user:${ownerId}`);
    const written = asCreated(withCreationTime(result.document, startedAt));
    // Only a create known to have landed stands in for reads that miss it (one whose wait timed out may never execute).
    if (result.confirmed !== false) this.rememberWrite('base', ownerId, written);
    else options.onUnconfirmed?.();
    const user = this.transformDocument(written);
    if (typeof result.confirmed === 'boolean') {
      (user as unknown as Record<string, unknown>).__createConfirmed = result.confirmed;
    }
    return user;
  }

  /**
   * Update user profile
   * Note: We must include ALL fields in the update to preserve existing values,
   * as Dash Platform document updates replace the entire document.
   */
  async updateProfile(ownerId: string, updates: UpdateUnifiedProfileData, options: UpdateProfileOptions = {}): Promise<User | null> {
    if (profileExtensionSource()) {
      try {
        return await this.saveV10Profile(ownerId, updates, options);
      } catch (error) {
        logger.error('UnifiedProfileService: Error updating profile:', error);
        throw error;
      }
    }

    try {
      cacheManager.invalidateByTag(`user:${ownerId}`);

      const rawProfile = await this.getRawProfile(ownerId);
      if (!rawProfile) {
        // A profile is optional, so the first edit creates it.
        const displayName = updates.displayName?.trim() || await this.defaultDisplayName(ownerId);
        return await this.createProfile(ownerId, { ...updates, displayName }, options);
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

      // This is already the complete contract payload. The inherited update()
      // merges a transformed User, which would reintroduce UI-only fields and
      // parsed arrays, and restore optional fields intentionally omitted above.
      const result = await stateTransitionService.updateDocument(
        this.contractId,
        this.documentType,
        docId,
        ownerId,
        documentData,
        rawProfile.$revision ?? 0
      );
      if (!result.success || !result.document) {
        throw new Error(result.error || 'Failed to update profile');
      }

      this.clearCache(docId);
      cacheManager.invalidateByTag(`user:${ownerId}`);
      const written = { $createdAt: rawProfile.$createdAt, ...result.document };
      // Only a write known to have landed stands in for older reads (one whose wait timed out may never execute).
      if (result.confirmed !== false) this.rememberWrite('base', ownerId, written);
      else options.onUnconfirmed?.();
      return this.transformDocument(written);
    } catch (error) {
      logger.error('UnifiedProfileService: Error updating profile:', error);
      throw error;
    }
  }

  /**
   * Get raw profile document (not transformed to User type)
   * Used internally to preserve field values during updates. Rejects when the
   * query fails, so an outage is never mistaken for a missing profile.
   */
  private async getRawProfile(ownerId: string): Promise<UnifiedProfileDocument | null> {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();

    const response = await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: 'profile',
      where: [['$ownerId', '==', ownerId]],
      limit: 1
    });

    // A node behind must not hand an edit the revision this client already replaced.
    const document = this.newestRecord('base', ownerId, this.normalizeDocumentResponse(response)[0] ?? null);
    return document ? this.extractDocumentData(document) : null;
  }

  /**
   * Whether `ownerId` has any profile document, read fresh. Unlike getProfile,
   * which answers a failed query with null, this rejects, so a caller can tell
   * a missing profile from an unreachable one.
   */
  async profileExists(ownerId: string): Promise<boolean> {
    if (profileExtensionSource()) {
      const { base, extension } = await this.getV10ProfileDocuments(ownerId);
      return base !== null || extension !== null;
    }
    return (await this.getRawProfile(ownerId)) !== null;
  }

  /** The name a first save gives a profile the user did not name: the DPNS label, else the identity. */
  private async defaultDisplayName(ownerId: string): Promise<string> {
    const username = await this.getUsername(ownerId);
    const name = username?.replace(/\.dash$/, '') || `User ${ownerId.slice(-6)}`;
    return name.slice(0, profileTextLimits().displayName);
  }

  // ==================== v10: DashPay profile + extension ====================

  /**
   * The v10 profile documents of `ownerId` (the DashPay `profile` and the
   * `yapprProfile` extension), read fresh because a replace must carry the
   * current revision. Rejects when a query fails, so an outage is never
   * mistaken for a missing profile.
   */
  private async getV10ProfileDocuments(ownerId: string): Promise<{ base: PlainDocument | null; extension: PlainDocument | null }> {
    const { getEvoSdk } = await import('./evo-sdk-service');
    const sdk = await getEvoSdk();
    const [base, extension] = await Promise.all((['base', 'extension'] as const).map(async (role) => {
      const source = this.sourceFor(role);
      const response = await sdk.documents.query({
        dataContractId: source.contractId,
        documentTypeName: source.documentType,
        where: [['$ownerId', '==', ownerId]],
        limit: 1
      });
      // A node behind must not hand an edit the revision this client already replaced.
      return this.newestRecord(role, ownerId, this.normalizeDocumentResponse(response)[0] ?? null);
    }));
    return { base, extension };
  }

  /**
   * Write a v10 profile edit: the DashPay profile first (the extension's
   * `ownerRefersTo` finds it, 40120 without), then the extension, each only
   * when it is missing or changes. An image avatar DashPay does not already
   * store is fetched once to hash and fingerprint it.
   */
  private async saveV10Profile(
    ownerId: string,
    data: UpdateUnifiedProfileData,
    { onProgress, onUnconfirmed }: UpdateProfileOptions = {}
  ): Promise<User> {
    cacheManager.invalidateByTag(`user:${ownerId}`);

    const paymentUris = data.paymentUris && uniqueStrings(data.paymentUris);
    if (paymentUris) assertListLimits(paymentUris, LIST_LIMITS.profilePaymentUris);
    const socialLinks = data.socialLinks && uniqueStrings(data.socialLinks.map(socialLinkToString));
    if (socialLinks) assertListLimits(socialLinks, LIST_LIMITS.profileSocialLinks);
    const patch: V10ProfilePatch = { ...data, paymentUris, socialLinks };

    const stored = await this.getV10ProfileDocuments(ownerId);
    // A first save of only an avatar or a banner still has to name the new DashPay profile.
    if (!stored.base && !patch.displayName?.trim()) patch.displayName = await this.defaultDisplayName(ownerId);
    const digestUrl = avatarNeedingDigest(stored.base, patch);
    const plan = planV10ProfileWrite({
      ...stored,
      patch,
      avatarDigest: digestUrl ? await this.imageDigestOrUndefined(digestUrl) : undefined,
      fallbackAvatar: this.encodeAvatarData(ownerId, DEFAULT_AVATAR_STYLE),
    });

    const total = (plan.base ? 1 : 0) + (plan.extension ? 1 : 0);
    let step = 0;
    const nextStep = () => onProgress?.({ step: ++step, total });

    // Only a write known to have landed stands in for reads that miss it (rememberWrite):
    // one whose wait timed out may never execute. Each document is remembered
    // as soon as it lands, so a later write failing does not leave it unguarded.
    const landed = (role: ProfileRole, record: PlainDocument) => {
      cacheManager.invalidateByTag(`user:${ownerId}`);
      this.rememberWrite(role, ownerId, record);
    };
    let base = stored.base;
    if (plan.base) {
      nextStep();
      const written = await this.writeProfileDocument('base', ownerId, stored.base, plan.base)
        .catch((error: unknown) => { throw dashpayKeyBoundsRefusal(error) ?? error; });
      base = written.document;
      // The extension's ownerRefersTo reads the DashPay profile from state, so
      // a create whose wait timed out must be visible before the extension goes.
      if (!stored.base && !written.confirmed) await this.waitForDashpayProfile(ownerId);
      if (written.confirmed || !stored.base) landed('base', base);
      else onUnconfirmed?.();
    }
    let extension = stored.extension;
    if (plan.extension) {
      nextStep();
      const written = await this.writeProfileDocument('extension', ownerId, stored.extension, plan.extension);
      extension = written.document;
      if (written.confirmed) landed('extension', extension);
      else onUnconfirmed?.();
    }

    cacheManager.invalidateByTag(`user:${ownerId}`);
    const merged = mergeV10ProfileRecords(base, extension);
    if (!merged) throw new Error('Profile not found');
    return this.transformDocument(merged);
  }

  /**
   * The digest DashPay stores beside an image avatar, or undefined when the
   * image cannot be fetched or decoded here (a host without CORS headers, an
   * SVG); the plan then keeps the image in the extension instead.
   */
  private async imageDigestOrUndefined(url: string): Promise<ImageDigest | undefined> {
    try {
      return await (await import('../media/image-digest')).imageDigestForUrl(url);
    } catch (error) {
      logger.warn('UnifiedProfileService: could not fingerprint the avatar; storing it in the Yappr profile only:', error);
      return undefined;
    }
  }

  /** Poll until a just-created DashPay profile is query-visible; rejects when it never shows. */
  private async waitForDashpayProfile(ownerId: string): Promise<void> {
    for (let attempt = 0; attempt < DASHPAY_PROFILE_POLLS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, DASHPAY_PROFILE_POLL_MS));
      if ((await this.getV10ProfileDocuments(ownerId)).base) return;
    }
    throw new Error('Your Dash profile has not landed yet. Please try again in a moment.');
  }

  /** Create or replace one v10 profile document; resolves to it as written. */
  private async writeProfileDocument(
    role: ProfileRole,
    ownerId: string,
    existing: PlainDocument | null,
    content: PlainDocument
  ): Promise<{ document: PlainDocument; confirmed: boolean }> {
    const source = this.sourceFor(role);
    const existingId = existing ? (existing.$id || existing.id) as string | undefined : undefined;
    if (existing && !existingId) throw new Error('Profile document ID not found');
    const result = existingId
      ? await stateTransitionService.updateDocument(
          source.contractId,
          source.documentType,
          existingId,
          ownerId,
          content,
          Number(existing?.$revision ?? existing?.revision ?? 0)
        )
      : await stateTransitionService.createDocument(source.contractId, source.documentType, ownerId, content);
    if (!result.success || !result.document) {
      throw new Error(result.error || `Failed to save the ${source.documentType} document`);
    }
    const document = { $createdAt: existing?.$createdAt ?? existing?.createdAt ?? Date.now(), ...result.document };
    return {
      document: existingId ? document : asCreated(document),
      confirmed: result.confirmed !== false,
    };
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
      // A profile whose read failed (logged by the batch) is left out, as one with no profile is; the rest still answer.
      const docs = await Promise.all(uniqueIds.map(id => this.loadProfileDoc(id).catch(() => null)));
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
