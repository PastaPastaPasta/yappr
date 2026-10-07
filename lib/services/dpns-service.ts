import { logger } from '@/lib/logger';
import { chunk, mapLimit } from './pagination-utils';
import { TtlMap } from '@/lib/caches/ttl-map';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { CREDITS_PER_DASH, DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE, keyNetwork } from '../constants';
import { documentToPlainObject, identifierToBase58, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel, getPurposeName, getSecurityLevelName } from '@/lib/crypto/identity-keys';
import type { UsernameCheckResult, UsernameRegistrationResult } from '../types';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import { profileSources } from '@/lib/profile/v10-profile';
import { getPrimaryUsername, sortUsernames } from '@/lib/utils/username';
import { dpnsRecordOwner } from '@/lib/utils/dpns-record-owner';
import {
  contestFundNeededFromError,
  extractErrorMessage,
  isContestFullError,
  isContestFundError,
  isContestedDocumentsNotYetAllowedError,
  isContestNotJoinableError,
} from '@/lib/error-utils';


/** Credits in one duff, the smallest Core unit (1e-8 DASH). */
const CREDITS_PER_DUFF = BigInt(CREDITS_PER_DASH) / 100_000_000n;

/**
 * `credits` in DASH, exact to the duff and without trailing zeros:
 * 20000000000n → "0.2". A price rounds up so it is never shown as less than
 * it is; a balance rounds down so it is never shown as more.
 */
export function formatCreditsAsDash(credits: bigint, round: 'up' | 'down' = 'up'): string {
  const duffs = (credits + (round === 'up' ? CREDITS_PER_DUFF - 1n : 0n)) / CREDITS_PER_DUFF;
  const whole = duffs / 100_000_000n;
  const fraction = (duffs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The least a contested DPNS name pays into its vote: 0.1 DASH from protocol
 * 14 and 0.2 DASH under protocol 12/13. It only goes up from here (it doubles
 * once a contest holds 250 contenders), so a balance below it is certain to
 * be refused, and checking it before the preorder saves that fee. The SDK
 * still prices the real fund just before it signs.
 */
export function minimumContestFundCredits(protocolVersion: number | null): bigint {
  const dash = protocolVersion === null || protocolVersion >= 14 ? 10n : 20n;
  return (BigInt(CREDITS_PER_DASH) * dash) / 100n;
}

/**
 * What a failed DPNS registration tells the user. A contested name (fewer than
 * 20 characters, only letters, hyphens and the digits 0 and 1) joins a
 * masternode vote and pays into its fund. The fund depends on the network's
 * protocol version (0.2 DASH under protocol 12/13, 0.1 DASH at protocol 14,
 * where it also doubles once a contest holds 250 contenders, platform#5034), so
 * no figure is hard-coded here. From 4.2.0-beta.5 the registration states the
 * most it pays (`contestFund`, #5039); Yappr leaves it out, so the SDK reads the
 * price just before it signs. The refusals below are what remains.
 */
export function describeDpnsRegistrationError(error: unknown): string {
  const message = extractErrorMessage(error);
  if (isContestFullError(error)) {
    return 'This name already has the most contenders a vote accepts, so it is closed to new registrations. Try a different name.';
  }
  if (isContestFundError(error)) {
    const needed = contestFundNeededFromError(error);
    const price = needed === null ? '' : ` (${formatCreditsAsDash(needed)} DASH now)`;
    return `Others joined the vote for this name while you were registering, so it now costs more to enter${price}. Try again to pay the current price.`;
  }
  // 40111: the contest for this name opened more than its join window ago (a
  // week on mainnet), so no new contender may enter until it ends.
  if (isContestNotJoinableError(error)) {
    return 'The vote for this name has been running too long to join. Wait for it to end, or pick a different name.';
  }
  if (isContestedDocumentsNotYetAllowedError(error)) {
    return 'This network does not accept contested names yet. Pick a name of 20 or more characters, or one with a digit from 2 to 9.';
  }
  // Drive: "Insufficient identity <id> balance <b> required <r>". A contested
  // name needs its contest fund on top of the fees.
  if (/insufficient identity .* balance/i.test(message)) {
    return 'Your identity does not have enough credits for this registration. A contested name also pays a contest fund into its vote, priced by the network before you sign. Top up and try again.';
  }
  return message || 'Registration failed';
}

/**
 * Extract documents array from SDK response (handles Map, Array, and object formats)
 */
function extractDocuments(response: unknown): Record<string, unknown>[] {
  if (response instanceof Map) {
    return Array.from(response.values())
      .filter(Boolean)
      .map(documentToPlainObject);
  }
  if (Array.isArray(response)) {
    return response.map(documentToPlainObject);
  }
  const maybeDocument = response as { toObject?: () => unknown };
  if (typeof maybeDocument.toObject === 'function') {
    return [documentToPlainObject(response)];
  }
  const respObj = response as { documents?: unknown[]; toJSON?: () => unknown };
  if (respObj?.documents) {
    return respObj.documents.map(documentToPlainObject);
  }
  if (respObj?.toJSON) {
    const json = respObj.toJSON() as { documents?: unknown[] } | unknown[];
    if (Array.isArray(json)) return json.map(documentToPlainObject);
    return ((json as { documents?: unknown[] }).documents || []).map(documentToPlainObject);
  }
  return [];
}

class DpnsService {
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000;
  /** lower-cased username -> identity id */
  private cache = new TtlMap<string, string>(DpnsService.CACHE_TTL_MS);
  /** identity id -> primary username */
  private reverseCache = new TtlMap<string, string>(DpnsService.CACHE_TTL_MS);

  /** Cache only complete DPNS lookup results; null records a proven absence. */
  private reverseMissCache = new TtlMap<string, true>(5 * 60 * 1000);

  private aliasCache = new TtlMap<string, string[]>(5 * 60 * 1000);

  hasCachedUsername(identityId: string): boolean {
    return this.reverseCache.has(identityId) || this.reverseMissCache.has(identityId);
  }

  seedUsernames(usernames: ReadonlyMap<string, string | null>): void {
    usernames.forEach((username, identityId) => {
      if (username) {
        this._cacheEntry(username, identityId);
      } else {
        this.reverseCache.delete(identityId);
        this.reverseMissCache.set(identityId, true);
      }
    });
  }

  /**
   * Helper method to cache entries in both directions
   */
  private _cacheEntry(username: string, identityId: string): void {
    this.cache.set(username.toLowerCase(), identityId);
    this.reverseCache.set(identityId, username);
    this.reverseMissCache.delete(identityId);
  }

  /**
   * Get all usernames for an identity ID
   */
  async getAllUsernames(identityId: string): Promise<string[]> {
    return (await this.getAllUsernamesSortedBatch([identityId])).get(identityId) ?? [];
  }

  async getAllUsernamesSorted(identityId: string): Promise<string[]> {
    return this.getAllUsernames(identityId);
  }

  /** Complete alias sets, chunked below the IN/row budgets and cursor-paged
   * for crowded identities. Never seed a partial set or a transport failure. */
  async getAllUsernamesSortedBatch(identityIds: string[]): Promise<Map<string, string[]>> {
    const ids = Array.from(new Set(identityIds.filter(Boolean)));
    const result = new Map<string, string[]>();
    const missing = ids.filter(id => {
      const cached = this.aliasCache.get(id);
      if (cached !== undefined) result.set(id, [...cached]);
      return cached === undefined;
    });
    if (missing.length === 0) return result;
    let sdk: Awaited<ReturnType<typeof getEvoSdk>>;
    try {
      sdk = await getEvoSdk();
    } catch (error) {
      logger.error('DPNS: SDK unavailable for aliases', error);
      return result;
    }
    // Leave headroom for absent branches and multiple aliases per identity.
    await mapLimit(chunk(missing, 40), 2, async batch => {
      try {
        let documents = extractDocuments(await sdk.documents.query({
          dataContractId: DPNS_CONTRACT_ID,
          documentTypeName: DPNS_DOCUMENT_TYPE,
          where: [['records.identity', 'in', batch]],
          orderBy: [['records.identity', 'asc']],
          limit: 100,
        }));
        if (documents.length + batch.length >= 100) {
          documents = [];
          for (const id of batch) {
            let startAfter: string | undefined;
            while (true) {
              const page = extractDocuments(await sdk.documents.query({
                dataContractId: DPNS_CONTRACT_ID,
                documentTypeName: DPNS_DOCUMENT_TYPE,
                where: [['records.identity', '==', id]],
                orderBy: [['records.identity', 'asc']],
                limit: 100,
                ...(startAfter ? { startAfter } : {}),
              }));
              documents.push(...page);
              if (page.length < 100) break;
              const last = page[page.length - 1];
              const next = identifierToBase58(last.$id || last.id);
              if (!next || next === startAfter) throw new Error('DPNS: alias cursor did not advance');
              startAfter = next;
            }
          }
        }
        const names = new Map<string, string[]>(batch.map(id => [id, []]));
        for (const doc of documents) {
          const data = (doc.data || doc) as Record<string, unknown>;
          // Only names an identity registered itself; the cursor above still pages past forgeries.
          const id = dpnsRecordOwner(doc);
          const label = data.label || data.normalizedLabel;
          if (id && typeof label === 'string') {
            names.get(id)?.push(`${label}.${data.normalizedParentDomainName || 'dash'}`);
          }
        }
        names.forEach((aliases, id) => {
          const sorted = sortUsernames(Array.from(new Set(aliases)));
          result.set(id, sorted);
          this.aliasCache.set(id, sorted);
          // Forward lookup knows every alias; reverse lookup knows the PRIMARY.
          sorted.forEach(name => this.cache.set(name.toLowerCase(), id));
          this.seedUsernames(new Map([[id, sorted[0] ?? null]]));
        });
      } catch (error) {
        logger.error('DPNS: Batch alias resolution error:', error);
      }
    });
    return result;
  }

  /** Primary names reuse complete alias reads; composite seeds remain valid. */
  async resolveUsernamesBatch(identityIds: string[]): Promise<Map<string, string | null>> {
    const ids = Array.from(new Set(identityIds.filter(Boolean)));
    const results = new Map<string, string | null>();
    const missing = ids.filter(id => {
      const name = this.reverseCache.get(id);
      if (name !== undefined) results.set(id, name);
      else if (this.reverseMissCache.has(id)) results.set(id, null);
      return !results.has(id);
    });
    const aliases = await this.getAllUsernamesSortedBatch(missing);
    missing.forEach(id => results.set(id, aliases.get(id)?.[0] ?? null));
    return results;
  }

  /**
   * Resolve a username for an identity ID (reverse lookup)
   * Returns the best username (contested usernames are preferred)
   */
  async resolveUsername(identityId: string): Promise<string | null> {
    try {
      // Check cache
      const cached = this.reverseCache.get(identityId);
      if (cached !== undefined) return cached;
      if (this.reverseMissCache.has(identityId)) return null;

      // Get all usernames for this identity and pick the primary one
      const allUsernames = await this.getAllUsernames(identityId);
      const bestUsername = getPrimaryUsername(allUsernames);

      if (!bestUsername) {
        return null;
      }

      this._cacheEntry(bestUsername, identityId);
      return bestUsername;
    } catch (error) {
      logger.error('DPNS: Error resolving username:', error);
      return null;
    }
  }

  /** The `domain` document for a lower-cased name (`alice` or `alice.dash`), or null when none is registered. */
  private async findDomain(normalizedUsername: string): Promise<Record<string, unknown> | null> {
    const sdk = await getEvoSdk();
    const [label, ...parent] = normalizedUsername.split('.');
    const documents = extractDocuments(await sdk.documents.query({
      dataContractId: DPNS_CONTRACT_ID,
      documentTypeName: DPNS_DOCUMENT_TYPE,
      where: [
        // DPNS stores the homograph-safe label (alice -> a11ce).
        ['normalizedLabel', '==', await sdk.dpns.convertToHomographSafe(label)],
        ['normalizedParentDomainName', '==', parent.join('.') || 'dash'],
      ],
      limit: 1,
    }));
    return documents[0] ?? null;
  }

  /**
   * Resolve an identity ID from a username. A name resolves only to the
   * identity that registered it (`dpnsRecordOwner`); a name whose record
   * points at someone else resolves to nobody. The SDK's `dpns.resolveName`
   * returns `records.identity` unchecked, so it is not used.
   */
  async resolveIdentity(username: string): Promise<string | null> {
    try {
      // Normalize: lowercase and remove .dash suffix
      const normalizedUsername = username.toLowerCase().replace(/\.dash$/, '');

      // Check cache first
      const cached = this.cache.get(normalizedUsername);
      if (cached !== undefined) return cached;

      const doc = await this.findDomain(normalizedUsername);
      const identityId = doc ? dpnsRecordOwner(doc) : null;
      if (identityId) this._cacheEntry(normalizedUsername, identityId);
      return identityId;
    } catch (error) {
      logger.error('DPNS: Error resolving identity:', error);
      return null;
    }
  }

  /**
   * Check if a username is available
   */
  async isUsernameAvailable(username: string): Promise<boolean> {
    try {
      const normalizedUsername = username.toLowerCase().replace(/\.dash$/, '');

      // Try native availability check first (more efficient)
      try {
        const sdk = await getEvoSdk();
        return await sdk.dpns.isNameAvailable(normalizedUsername);
      } catch {
        // Fallback to the document query
      }

      // Not resolveIdentity: a forged name resolves to nobody but is still taken.
      return (await this.findDomain(normalizedUsername)) === null;
    } catch (error) {
      logger.error('DPNS: Error checking username availability:', error);
      // If error, assume not available to be safe
      return false;
    }
  }

  /**
   * Search for usernames by prefix with full details
   */
  async searchUsernamesWithDetails(prefix: string, limit: number = 10): Promise<Array<{ username: string; ownerId: string }>> {
    try {
      const sdk = await getEvoSdk();

      // Remove .dash suffix if present for search
      const cleanPrefix = prefix.toLowerCase().replace(/\.dash$/, '');

      // Normalize the search prefix to match how DPNS stores normalizedLabel
      const searchPrefix = await sdk.dpns.convertToHomographSafe(cleanPrefix);

      const query = {
        dataContractId: DPNS_CONTRACT_ID,
        documentTypeName: DPNS_DOCUMENT_TYPE,
        where: [
          ['normalizedLabel', 'startsWith', searchPrefix],
          ['normalizedParentDomainName', '==', 'dash'],
        ] as DocumentWhereClause[],
        orderBy: [['normalizedLabel', 'asc']] as DocumentOrderByClause[], limit,
      };
      let documents: Record<string, unknown>[] | undefined;
      if (likesAreIndexOnly()) {
        try {
          // One sub-query per profile document type (v10: the DashPay profile and the extension).
          const sources = profileSources();
          const result = await sdk.documents.composite({
            dataContractId: DPNS_CONTRACT_ID, documentType: DPNS_DOCUMENT_TYPE,
            where: query.where, orderBy: query.orderBy, limit,
            subQueries: sources.map(({ source }) => ({ dataContractId: source.contractId, documentType: source.documentType,
              bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' } })),
          });
          const profiles = result.subResults ?? [];
          if (!Array.isArray(result.pageDocuments) || profiles.length !== sources.length ||
              profiles.some(sub => sub?.kind !== 'documents' || !Array.isArray(sub.documents))) {
            throw new Error('DPNS search: incomplete composite response');
          }
          documents = result.pageDocuments.map(documentToPlainObject);
          const owners = documents.map(doc => String(doc.$ownerId || doc.ownerId));
          const { unifiedProfileService } = await import('./unified-profile-service');
          sources.forEach(({ role }, i) => {
            const sub = profiles[i];
            if (sub.kind === 'documents') unifiedProfileService.seedProfileDocuments(sub.documents.map(documentToPlainObject), owners, role);
          });
        } catch (error) {
          logger.warn('DPNS search composite failed; using ordinary search', error);
        }
      }
      documents ??= extractDocuments(await sdk.documents.query(query));
      // A name whose record points at another identity resolves to nobody, so it is no search hit either.
      return documents.flatMap((doc) => {
        const ownerId = dpnsRecordOwner(doc);
        if (!ownerId) return [];
        const data = (doc.data || doc) as Record<string, unknown>;
        const label = (data.label || data.normalizedLabel || 'unknown') as string;
        const parentDomain = (data.normalizedParentDomainName || 'dash') as string;
        return [{ username: `${label}.${parentDomain}`, ownerId }];
      });
    } catch (error) {
      logger.error('DPNS: Error searching usernames with details:', error);
      return [];
    }
  }

  /**
   * The enabled CRITICAL or HIGH authentication key the private key corresponds
   * to. DPNS registration may not be signed with MASTER.
   */
  private findMatchingSigningKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[]
  ): WasmIdentityPublicKey | null {
    const result = matchIdentityKey(privateKeyWif, wasmPublicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    });
    if (!result.ok) {
      logger.error(
        result.reason === 'rejected'
          ? `DPNS: Private key matches key id=${result.match.keyId} (purpose ${getPurposeName(result.match.purpose)}, level ${getSecurityLevelName(result.match.securityLevel)}), which cannot sign this operation: CRITICAL or HIGH AUTHENTICATION required`
          : `DPNS: Private key does not match any enabled key on this identity`
      );
      return null;
    }
    logger.debug(`DPNS: Matched private key to identity key: id=${result.match.keyId}, securityLevel=${getSecurityLevelName(result.match.securityLevel)}`);
    return result.key;
  }

  /**
   * Register a new username using the SDK API
   */
  async registerUsername(
    label: string,
    identityId: string,
    privateKeyWif: string,
    onPreorderSuccess?: () => void
  ): Promise<{ success: boolean }> {
    try {
      const sdk = await getEvoSdk();

      // Validate the username first using SDK
      const isValid = await sdk.dpns.isValidUsername(label);
      if (!isValid) {
        throw new Error(`Invalid username format: ${label}`);
      }

      // Check if it's contested
      const isContested = await sdk.dpns.isContestedUsername(label);
      if (isContested) {
        logger.warn(`Username ${label} is contested and will require masternode voting`);
      }

      // Check availability
      const isAvailable = await sdk.dpns.isNameAvailable(label);
      if (!isAvailable) {
        throw new Error(`Username ${label} is already taken`);
      }

      // Fetch identity to validate and get public key info
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      if (isContested) {
        // Refuse before the preorder is paid: registerName pays it first and
        // only then finds the balance short of the contest fund.
        const protocolVersion = await sdk.epoch.current().then(
          (epoch) => epoch.protocolVersion,
          (error) => {
            logger.warn('DPNS: epoch read failed; checking the lowest contest fund:', extractErrorMessage(error));
            return null;
          }
        );
        const minimumFund = minimumContestFundCredits(protocolVersion);
        if (identity.balance < minimumFund) {
          throw new Error(
            `${label} is a contested name, and entering its vote pays at least ${formatCreditsAsDash(minimumFund)} DASH from your credits. ` +
            `This identity has ${formatCreditsAsDash(identity.balance, 'down')} DASH. Top up, or pick a name of 20 or more characters or one with a digit from 2 to 9.`
          );
        }
      }

      // Get WASM public keys to find the matching signing key
      const wasmPublicKeys = identity.publicKeys;

      // Find a signing key that matches the provided private key
      // DPNS operations require CRITICAL or HIGH security level
      const identityKey = this.findMatchingSigningKey(privateKeyWif, wasmPublicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your private key. DPNS operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.debug(`DPNS: Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // Create signer and identity key for the state transition
      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKeyWif,
        identityKey
      );

      // Register the name. `contestFund` is left out on purpose: for a contested
      // name the SDK reads the fund to join just before it signs (beta.5), which
      // is the least that is accepted and what is charged.
      logger.debug(`Registering DPNS name: ${label}`);
      await sdk.dpns.registerName({
        label,
        identity,
        identityKey: signingKey,
        signer,
        preorderCallback: onPreorderSuccess
      });

      // Clear cache for this identity
      this.clearCache(undefined, identityId);

      return { success: true };
    } catch (error) {
      logger.error('Error registering username:', error);
      throw error;
    }
  }

  /**
   * Validate a username according to DPNS rules
   */
  async validateUsername(label: string): Promise<{
    isValid: boolean;
    isContested: boolean;
    normalizedLabel: string;
  }> {
    const sdk = await getEvoSdk();
    const isValid = await sdk.dpns.isValidUsername(label);
    const isContested = await sdk.dpns.isContestedUsername(label);
    const normalizedLabel = await sdk.dpns.convertToHomographSafe(label);

    return {
      isValid,
      isContested,
      normalizedLabel
    };
  }

  /**
   * Get username validation error message (basic client-side validation)
   * For full DPNS validation, use validateUsername() which requires SDK
   */
  getUsernameValidationError(username: string): string | null {
    if (!username) {
      return 'Username is required';
    }

    if (username.length < 3) {
      return 'Username must be at least 3 characters long';
    }

    if (username.length > 63) {
      return 'Username must be 63 characters or less';
    }

    if (!/^[a-zA-Z0-9-]+$/.test(username)) {
      return 'Username can only contain letters, numbers, and hyphens';
    }

    if (username.startsWith('-') || username.endsWith('-')) {
      return 'Username cannot start or end with a hyphen';
    }

    if (username.includes('--')) {
      return 'Username cannot contain consecutive hyphens';
    }

    return null;
  }


  /**
   * Batch check availability and contested status for multiple usernames
   */
  async batchCheckAvailability(labels: string[]): Promise<Map<string, UsernameCheckResult>> {
    const results = new Map<string, UsernameCheckResult>();

    // Check each username in parallel
    const checks = await Promise.allSettled(
      labels.map(async (label) => {
        const normalizedLabel = label.toLowerCase().replace(/\.dash$/, '');
        try {
          const sdk = await getEvoSdk();
          const [available, contested] = await Promise.all([
            sdk.dpns.isNameAvailable(normalizedLabel),
            sdk.dpns.isContestedUsername(normalizedLabel),
          ]);
          return { label: normalizedLabel, available, contested };
        } catch (error) {
          return {
            label: normalizedLabel,
            available: false,
            contested: false,
            error: error instanceof Error ? error.message : 'Check failed',
          };
        }
      })
    );

    // Process results
    for (const result of checks) {
      if (result.status === 'fulfilled') {
        const { label, available, contested, error } = result.value;
        results.set(label, { available, contested, error });
      }
    }

    return results;
  }

  /**
   * Register multiple usernames sequentially with progress callback
   * Uses typed API (publicKeyId no longer needed - key is found from identity)
   */
  async registerUsernamesSequentially(
    registrations: Array<{
      label: string;
      identityId: string;
      privateKeyWif: string;
      publicKeyId?: number; // Deprecated, kept for backwards compatibility but ignored
    }>,
    onProgress?: (index: number, total: number, label: string) => void
  ): Promise<UsernameRegistrationResult[]> {
    const results: UsernameRegistrationResult[] = [];

    for (let i = 0; i < registrations.length; i++) {
      const reg = registrations[i];
      onProgress?.(i, registrations.length, reg.label);

      // Known before the attempt, so a failure still says whether the name was contested.
      let isContested = false;
      try {
        const sdk = await getEvoSdk();
        isContested = await sdk.dpns.isContestedUsername(reg.label);

        await this.registerUsername(
          reg.label,
          reg.identityId,
          reg.privateKeyWif
        );

        results.push({
          label: reg.label,
          success: true,
          isContested,
        });
      } catch (error) {
        results.push({
          label: reg.label,
          success: false,
          isContested,
          error: describeDpnsRegistrationError(error),
        });
      }
    }

    return results;
  }

  /**
   * Clear cache entries
   */
  clearCache(username?: string, identityId?: string): void {
    if (identityId) this.aliasCache.delete(identityId);
    else this.aliasCache.clear();
    if (username) {
      this.cache.delete(username.toLowerCase());
    }
    if (identityId) {
      this.reverseCache.delete(identityId);
      this.reverseMissCache.delete(identityId);
    }
    if (!username && !identityId) {
      this.cache.clear();
      this.reverseCache.clear();
      this.reverseMissCache.clear();
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    this.cache.prune();
    this.reverseCache.prune();
    this.reverseMissCache.prune();
    this.aliasCache.prune();
  }
}

// Singleton instance
export const dpnsService = new DpnsService();

// Set up periodic cache cleanup
if (typeof window !== 'undefined') {
  setInterval(() => {
    dpnsService.cleanupCache();
  }, 3600000); // Clean up every hour
}
