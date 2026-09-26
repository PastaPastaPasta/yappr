import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { documentBuilderService } from './document-builder-service';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel, getPurposeName, getSecurityLevelName } from '@/lib/crypto/identity-keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { promptForAuthKey } from '../auth-utils';
import { BLOG_YAPP_TOKEN_COSTS, STOREFRONT_YAPP_TOKEN_COSTS, YAPPR_BLOG_CONTRACT_ID, YAPPR_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID, YAPP_TOKEN_POSITION, blogIsV2, keyNetwork, storefrontIsV2 } from '../constants';
import { declaredActionFee, tokenCostFor, type DocumentAction } from '../contract-topology';
import { planPayment } from '../payment-preference';
import { DEFAULT_FEE_MULTIPLIER_PERMILLE, actionFeeAgreementOptions, tokenPaymentOptions } from '../transition-agreements';
import { extractErrorMessage, isTimeoutError, isAlreadyExistsError, isNonFatalWaitError, isFeeMultiplierNotToleratedError } from '../error-utils';
import { useSettingsStore } from '../store';
import { tokenService } from './token-service';
import { identityService } from './identity-service';
import { documentToPlainObject } from './sdk-helpers';
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes';
import { documentIdForCreate, nextIdentityContractNonce } from '@/lib/document-id';
import {
  DocumentActionFeeAgreement,
  DocumentCreateTransition,
  BatchedTransition,
  BatchTransition,
  StateTransition,
  PrivateKey,
  Identifier,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk';
import type { TokenPaymentInfoOptions } from '@dashevo/wasm-sdk';


export interface StateTransitionResult {
  success: boolean;
  transactionHash?: string;
  document?: Record<string, unknown>;
  /** Whether the document is confirmed query-visible on Platform. */
  confirmed?: boolean;
  error?: string;
}

/** Key for localStorage ST cache */
const ST_CACHE_PREFIX = scopedKey('yappr:pending-st:');

/** Max age for cached ST entries (24 hours in ms) */
const ST_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Hard cap on cached entries as a safety net */
const ST_CACHE_MAX_ENTRIES = 50;

interface CachedSTEntry {
  /** Base64-encoded ST bytes */
  data: string;
  /** Timestamp when cached (ms since epoch) */
  cachedAt: number;
}

/**
 * The epoch fee multiplier (permille) the last action fee agreement was priced
 * with. Read once per session from `epoch.current()`, forgotten on a 40134 so
 * the next write re-reads it. Consensus charges the EXECUTING epoch's
 * multiplier whatever this says; the agreement only bounds how far above the
 * known value it may be.
 */
let knownFeeMultiplierPermille: bigint | null = null;

type ConnectedSdk = Awaited<ReturnType<typeof getEvoSdk>>;

/**
 * The owner's credit balance a wait result carries, or null. wasm-sdk
 * 4.2.0-beta.4 sets it as an untyped `ownerBalance` bigint on the verified
 * result (platform#4887) — present for owned, fee-paying transitions proved
 * at protocol 14, absent otherwise — so it is read defensively.
 */
export function ownerBalanceOf(result: unknown): bigint | null {
  if (typeof result !== 'object' || result === null) return null;
  const value = (result as { ownerBalance?: unknown }).ownerBalance;
  return typeof value === 'bigint' ? value : null;
}

/** Cache the owner balance a wait result carried, when it carried one. */
function recordOwnerBalance(ownerId: string, result: unknown): void {
  const ownerBalance = ownerBalanceOf(result);
  if (ownerBalance !== null) identityService.recordBalance(ownerId, ownerBalance);
}

async function currentFeeMultiplierPermille(sdk: ConnectedSdk): Promise<bigint> {
  if (knownFeeMultiplierPermille !== null) return knownFeeMultiplierPermille;
  try {
    knownFeeMultiplierPermille = BigInt((await sdk.epoch.current()).feeMultiplierPermille);
    return knownFeeMultiplierPermille;
  } catch (error) {
    // Better to agree at the default than to send no agreement: 40132 is
    // certain without one, 40134 unlikely at the default with a 20% tolerance.
    logger.warn('Epoch read failed; agreeing to the action fee at the default multiplier:', extractErrorMessage(error));
    return DEFAULT_FEE_MULTIPLIER_PERMILLE;
  }
}

/**
 * Save serialized state transition bytes for retry.
 * Uses localStorage for persistence across page reloads.
 */
function savePendingSTBytes(documentId: string, bytes: Uint8Array): void {
  try {
    const key = ST_CACHE_PREFIX + documentId;
    const entry: CachedSTEntry = {
      data: bytesToBase64(bytes),
      cachedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch (err) {
    logger.warn('Failed to save pending ST bytes:', err);
  }
}

/**
 * Load previously saved state transition bytes.
 */
function loadPendingSTBytes(documentId: string): Uint8Array | null {
  try {
    const key = ST_CACHE_PREFIX + documentId;
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    // Entries are JSON with a timestamp; plain base64 is an older shape still read.
    let base64: string;
    try {
      const parsed = JSON.parse(raw) as CachedSTEntry;
      // Check if entry is expired
      if (parsed.cachedAt && Date.now() - parsed.cachedAt > ST_CACHE_MAX_AGE_MS) {
        localStorage.removeItem(key);
        return null;
      }
      base64 = parsed.data;
    } catch {
      // Legacy format: plain base64 string
      base64 = raw;
    }

    return base64ToBytes(base64);
  } catch {
    return null;
  }
}

/**
 * Clear saved state transition bytes after confirmation.
 */
function clearPendingSTBytes(documentId: string): void {
  try {
    localStorage.removeItem(ST_CACHE_PREFIX + documentId);
  } catch {
    // Ignore
  }
}

/**
 * Clean up old pending ST entries older than 24 hours,
 * and enforce a hard cap of ST_CACHE_MAX_ENTRIES.
 */
function cleanupOldPendingSTs(): void {
  try {
    const now = Date.now();
    const entries: { key: string; cachedAt: number }[] = [];
    const keysToRemove: string[] = [];

    // Collect all ST cache keys first to avoid index-shifting bugs
    // when calling removeItem() during index-based iteration.
    const allKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(ST_CACHE_PREFIX)) allKeys.push(key);
    }

    for (const key of allKeys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;

      let cachedAt = 0;
      try {
        const parsed = JSON.parse(raw) as CachedSTEntry;
        cachedAt = parsed.cachedAt ?? 0;
      } catch {
        // Legacy entry without timestamp — treat as expired
        cachedAt = 0;
      }

      // Evict entries older than 24h; an entry without a timestamp is older still.
      if (cachedAt === 0 || now - cachedAt > ST_CACHE_MAX_AGE_MS) {
        keysToRemove.push(key);
        continue;
      }

      entries.push({ key, cachedAt });
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    // If still over the hard cap, remove oldest first
    if (entries.length > ST_CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => a.cachedAt - b.cachedAt);
      for (let i = 0; i < entries.length - ST_CACHE_MAX_ENTRIES; i++) {
        localStorage.removeItem(entries[i].key);
      }
    }
  } catch {
    // Ignore
  }
}

class StateTransitionService {
  /**
   * Get the private key from secure storage
   */
  private async getPrivateKey(identityId: string): Promise<string> {
    if (typeof window === 'undefined') {
      throw new Error('State transitions can only be performed in browser');
    }

    const { getPrivateKey } = await import('../secure-storage');
    const privateKey = getPrivateKey(identityId);

    if (!privateKey) {
      promptForAuthKey();
      throw new Error('Private key not found. Please re-enter your key.');
    }

    return privateKey;
  }

  /**
   * The enabled CRITICAL or HIGH authentication key the stored private key
   * corresponds to. Document operations may not be signed with MASTER.
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
          ? `Private key matches key id=${result.match.keyId} (purpose ${getPurposeName(result.match.purpose)}, level ${getSecurityLevelName(result.match.securityLevel)}), which cannot sign this operation: CRITICAL or HIGH AUTHENTICATION required`
          : `Private key does not match any enabled key on this identity`
      );
      return null;
    }
    logger.debug(`Matched private key to identity key: id=${result.match.keyId}, securityLevel=${getSecurityLevelName(result.match.securityLevel)}`);
    return result.key;
  }

  /**
   * Check if a document already exists on Platform by ID.
   * Returns the document if found, null if not found.
   * Throws on network/transport errors so callers can handle them.
   */
  private async checkDocumentExists(
    contractId: string,
    documentType: string,
    documentId: string
  ): Promise<Record<string, unknown> | null> {
    const sdk = await getEvoSdk();
    try {
      const doc = await sdk.documents.get(contractId, documentType, documentId);
      if (doc) {
        // Normalize zero-arg toObject() output back to the JSON-like shape Yappr expects.
        return documentToPlainObject(doc);
      }
      return null;
    } catch (err) {
      // If the error indicates the document was not found, return null.
      // Otherwise, let network/transport errors propagate.
      const msg = extractErrorMessage(err).toLowerCase();
      if (msg.includes('not found') || msg.includes('404') || msg.includes('no document')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Wait (briefly) for a document to become queryable.
   *
   * Only needed after a create that came back UNCONFIRMED: `createDocument`
   * normally waits for the transition to execute in a block, so its success means
   * the document is already there. When DAPI's confirmation wait times out the
   * broadcast usually still landed, but nothing has proven it — and on a topology
   * where every reference is `refersTo`-checked, writing a child against an
   * unproven parent is rejected by consensus and the fee is spent anyway.
   *
   * Returns false rather than throwing when the document is still not visible
   * after `attempts` polls, so callers can tell the user to retry.
   */
  async waitForDocument(
    contractId: string,
    documentType: string,
    documentId: string,
    { attempts = 6, intervalMs = 3_000 }: { attempts?: number; intervalMs?: number } = {}
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (await this.checkDocumentExists(contractId, documentType, documentId)) return true;
      } catch (error) {
        // A transport failure says nothing about whether the document landed.
        logger.warn(`waitForDocument: probe failed for ${documentType} ${documentId}:`, extractErrorMessage(error));
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /**
   * The `$tokenPaymentInfo` a create of `documentType` should carry, or
   * undefined when it pays credits (an unpriced type, or an `optional` cost the
   * viewer chose not to pay in YAPP). Three contracts declare a `tokenCost`:
   * the social contract charges its own YAPP, while storefront v2+ and blog
   * v2+ charge the SOCIAL contract's YAPP — a cross-contract cost, so those
   * agreements name that contract explicitly and stay required (neither
   * contract declares `optional`).
   *
   * On the social contract the bag follows the viewer's payment plan: on v2
   * the cost is required and this is the historical position-and-cap bag; on
   * v9 the `payWith` setting and the YAPP balance decide, a `yapp` plan adds
   * the contract's gas offer (PreferContractOwner) and a `credits` plan sends
   * nothing at all.
   *
   * A balance read that FAILS plans credits, so an unknown balance can never
   * become a 40700. A read that succeeds but is STALE still can — Platform
   * reads lag writes, two tabs plan against the same balance, and the cached-ST
   * replay re-sends a payment the YAPP may since have left. Those surface as
   * insufficient-YAPP, which on an optional cost tells the user they can switch
   * to credits rather than only offering to sell them more.
   */
  private async resolveTokenPayment(
    contractId: string,
    documentType: string,
    ownerId: string
  ): Promise<TokenPaymentInfoOptions | undefined> {
    if (contractId === YAPPR_CONTRACT_ID) {
      const cost = tokenCostFor(documentType);
      if (!cost) return undefined;
      // The balance only matters when it can change the answer: paying in YAPP
      // on an optional cost, where too little means planning credits instead. A
      // user who chose credits, or a required cost consensus gives no choice
      // about, must not pay a balance round-trip on every like.
      const payWith = useSettingsStore.getState().payWith;
      const balance = cost.optional && payWith === 'yapp' ? await this.yappBalanceOrNull(ownerId) : null;
      const plan = planPayment(documentType, 'create', balance, payWith);
      if (plan.fallbackReason) logger.debug(`Paying ${documentType} in ${plan.payWith} (${plan.fallbackReason})`);
      return tokenPaymentOptions(plan, YAPP_TOKEN_POSITION);
    }
    const crossContract = (amount: number | undefined): TokenPaymentInfoOptions | undefined =>
      amount ? { paymentTokenContractId: YAPPR_CONTRACT_ID, tokenContractPosition: YAPP_TOKEN_POSITION, maximumTokenCost: BigInt(amount) } : undefined;
    if (contractId === YAPPR_STOREFRONT_CONTRACT_ID && storefrontIsV2()) {
      return crossContract((STOREFRONT_YAPP_TOKEN_COSTS as Record<string, number>)[documentType]);
    }
    if (contractId === YAPPR_BLOG_CONTRACT_ID && blogIsV2()) {
      return crossContract((BLOG_YAPP_TOKEN_COSTS as Record<string, number>)[documentType]);
    }
    return undefined;
  }

  private async yappBalanceOrNull(ownerId: string): Promise<bigint | null> {
    try {
      return await tokenService.getBalance(ownerId);
    } catch (error) {
      logger.warn('YAPP balance unavailable; paying in credits:', extractErrorMessage(error));
      return null;
    }
  }

  /**
   * The `$actionFeeAgreement` a transition on `documentType`/`action` must
   * carry, or undefined when the contract charges nothing for it (every action
   * on v2; every action but `post`/`reply` create on v9). Built from the
   * contract's declared amounts and the multiplier this session knows: a
   * different amount is 40133, no agreement is 40132.
   */
  private async resolveActionFeeAgreement(
    sdk: ConnectedSdk,
    contractId: string,
    documentType: string,
    action: DocumentAction
  ): Promise<DocumentActionFeeAgreement | undefined> {
    if (contractId !== YAPPR_CONTRACT_ID) return undefined;
    const fee = declaredActionFee(documentType, action);
    if (!fee) return undefined;
    const agreement = new DocumentActionFeeAgreement(actionFeeAgreementOptions(fee, await currentFeeMultiplierPermille(sdk)));
    logger.debug(`Agreeing to the ${documentType} ${action} fee: moderators=${fee.moderators} owner=${fee.owner} at ${agreement.knownFeeMultiplierPermille ?? 'fixed'} permille`);
    return agreement;
  }

  /**
   * The facade's `replace`/`delete` options cannot carry an action fee
   * agreement, so a priced replace or delete would be a paid 40132. No cut
   * prices those actions (`lib/contract-topology.test.ts` pins it); should one,
   * this fails BEFORE signing rather than after paying.
   */
  private assertUnpricedAction(contractId: string, documentType: string, action: DocumentAction): void {
    if (contractId === YAPPR_CONTRACT_ID && declaredActionFee(documentType, action)) {
      throw new Error(`${documentType} ${action} charges an action fee, which this write path cannot agree to yet`);
    }
  }

  /**
   * Create a document with idempotent retry via ST byte caching.
   *
   * This is the typed write path: `documentData` should already use `Uint8Array` for binary
   * fields before it is wrapped in a `Document`. It may be a function of the document's id
   * for data that must commit to the id before the document exists (the auth vault binds
   * its ciphertext to the vault id as AEAD associated data): the function is called once,
   * with the id the create transition WILL carry, and the same nonce is then used for the
   * broadcast, so the id the data was built against is the id Platform stores.
   *
   * Instead of using sdk.documents.create() (which atomically builds,
   * signs, broadcasts, and waits — bumping the nonce each time), we:
   *
   * 1. Fetch the identity contract nonce from Platform and pick the next one
   * 2. Derive the document id from that nonce (protocol 14; wasm-dpp2's
   *    `Document.generateId` via `lib/document-id.ts`) and build the Document
   *    with it, wrapped in a DocumentCreateTransition
   * 3. Bundle into a BatchTransition → StateTransition carrying the same nonce
   * 4. Sign the StateTransition
   * 5. Cache the signed ST bytes (localStorage), keyed by the id
   * 6. Broadcast via sdk.stateTransitions.broadcastStateTransition()
   * 7. Wait via sdk.stateTransitions.waitForResponse()
   *
   * When a call finds cached bytes under its id it rebroadcasts that SAME
   * signed ST instead of building a new one: Platform either accepts it or
   * reports it already processed, and no new nonce is spent.
   *
   * Be clear about what that buys today. The id is a function of the nonce and
   * of fresh entropy, so a fresh call always derives a fresh id and never finds
   * its predecessor's bytes; the cache only replays when a caller re-derives
   * the same id, which none does (equally true before protocol 14, when the id
   * was a function of fresh entropy alone). The guard against a double write
   * on a timed-out wait is therefore the optimistic `confirmed: false` return
   * below, which callers surface as "may have succeeded" rather than retrying.
   * Making the cache reachable needs a caller-supplied idempotency key to key
   * it by — a separate change.
   *
   * There is no pre-create "already exists" probe by id for the same reason:
   * a document under a freshly derived id can only exist if THIS signed
   * transition already landed, which is exactly what the cached-bytes path
   * checks.
   */
  async createDocument(
    contractId: string,
    documentType: string,
    ownerId: string,
    documentData: Record<string, unknown> | ((documentId: string) => Promise<Record<string, unknown>> | Record<string, unknown>),
    options?: {
      /**
       * An explicit token payment agreement, overriding the one resolved from
       * the contract's declarations and the viewer's payment plan.
       * `maximumTokenCost` is the cap the user agrees to spend. Token position
       * defaults to 0 (the YAPP token).
       */
      tokenPayment?: {
        tokenContractPosition?: number;
        /** The contract defining the token when it is not `contractId` (cross-contract tokenCost). */
        paymentTokenContractId?: string;
        maximumTokenCost: number;
      };
      /**
       * How to confirm the transition. `'strict'` (default) is the historical
       * path: `waitForResponse` plus get-by-id existence probes and ST-byte
       * caching for idempotent rebroadcast.
       *
       * `'affectedState'` is for **indexOnly** document types (v9 likes): those
       * have no id-addressable stored row, so `documents.get` can never confirm
       * one (which also makes the ST-byte replay cache useless — its probe
       * would never resolve), and their proofs resolve as an affected-state
       * snapshot rather than `ExecutionProved`, which strict waiting rejects
       * even though the write landed. This mode skips every get-by-id probe and
       * waits via `waitForAffectedState`; callers that need a stronger
       * confirmation must read the write back through a value query.
       */
      confirmation?: 'strict' | 'affectedState';
    }
  ): Promise<StateTransitionResult> {
    const affectedStateMode = options?.confirmation === 'affectedState';
    try {
      const sdk = await getEvoSdk();
      const wasm = sdk.wasm;
      const privateKeyWif = await this.getPrivateKey(ownerId);

      // Validate signing key
      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKeyWif, wasmPublicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.debug(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // --- The nonce comes first: the document id is derived from it ---
      // DIP-30: nonce is u64 where lower 40 bits = sequence number,
      // upper 24 bits = missing revision bitset. Only increment the sequence part.
      const currentNonce = await sdk.identities.contractNonce(ownerId, contractId);
      const newNonce = nextIdentityContractNonce(currentNonce);
      logger.debug(`Nonce: current=${currentNonce}, using=${newNonce}`);

      const entropy = crypto.getRandomValues(new Uint8Array(32));
      const documentId = documentIdForCreate({ contractId, ownerId, documentTypeName: documentType, entropy, identityContractNonce: newNonce });
      const resolvedData = typeof documentData === 'function' ? await documentData(documentId) : documentData;
      logger.debug(`Creating ${documentType} document ${documentId} with data:`, resolvedData);

      // Build the typed Document. Binary fields remain Uint8Array on this path.
      const document = await documentBuilderService.buildDocumentForCreate(
        contractId,
        documentType,
        ownerId,
        resolvedData,
        { entropy, identityContractNonce: newNonce }
      );
      const resultDocument = { $id: documentId, $ownerId: ownerId, $type: documentType, ...resolvedData };

      // --- Check for a cached ST from a previous timed-out attempt ---
      // Meaningless in affectedState mode: the replay flow settles through
      // get-by-id probes an indexOnly doctype cannot answer.
      const cachedBytes = affectedStateMode ? null : loadPendingSTBytes(documentId);
      if (cachedBytes) {
        logger.debug(`Found cached ST bytes for ${documentId} — checking Platform...`);

        // First check if it already landed
        const existingDoc = await this.checkDocumentExists(contractId, documentType, documentId);
        if (existingDoc) {
          logger.debug(`Document ${documentId} already confirmed on Platform`);
          clearPendingSTBytes(documentId);
          return { success: true, transactionHash: documentId, document: existingDoc, confirmed: true };
        }

        // Not confirmed yet — rebroadcast the same ST
        logger.debug(`Rebroadcasting cached ST for ${documentId}...`);
        try {
          const cachedST = StateTransition.fromBytes(cachedBytes);
          await sdk.stateTransitions.broadcastStateTransition(cachedST);
          const result = await sdk.stateTransitions.waitForResponse(cachedST);
          logger.debug(`Rebroadcast succeeded for ${documentId}`, result);
          recordOwnerBalance(ownerId, result);
          clearPendingSTBytes(documentId);
          try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
          return { success: true, transactionHash: documentId, document: resultDocument, confirmed: true };
        } catch (rebroadcastErr) {
          if (isAlreadyExistsError(rebroadcastErr)) {
            // Already processed — confirm on Platform
            const doc = await this.checkDocumentExists(contractId, documentType, documentId);
            if (doc) {
              clearPendingSTBytes(documentId);
              return { success: true, transactionHash: documentId, document: doc, confirmed: true };
            }
          }
          if (isTimeoutError(rebroadcastErr)) {
            // Still timing out — check Platform one more time
            const doc = await this.checkDocumentExists(contractId, documentType, documentId);
            if (doc) {
              clearPendingSTBytes(documentId);
              return { success: true, transactionHash: documentId, document: doc, confirmed: true };
            }
          }
          // Genuine failure on rebroadcast — clear cache and fall through to create fresh.
          // A 40134 here is about the multiplier the CACHED bytes agreed to, and the
          // fresh transition built below prices its agreement from the same session
          // cache: without this it is refused for the identical reason.
          if (isFeeMultiplierNotToleratedError(rebroadcastErr)) knownFeeMultiplierPermille = null;
          logger.warn('Rebroadcast failed, will create fresh ST:', extractErrorMessage(rebroadcastErr));
          clearPendingSTBytes(documentId);
        }
      }

      // --- Build the StateTransition manually ---

      // What the write pays and agrees to: the token payment (or none, for a
      // credits write on an optional cost) and the action fee agreement the
      // type demands. Both are part of the signed bytes cached below, so the
      // rebroadcast path above replays them verbatim — correct, since the
      // amounts are fixed at type creation.
      const paymentOptions: TokenPaymentInfoOptions | undefined = options?.tokenPayment
        ? {
            ...(options.tokenPayment.paymentTokenContractId ? { paymentTokenContractId: options.tokenPayment.paymentTokenContractId } : {}),
            tokenContractPosition: options.tokenPayment.tokenContractPosition ?? YAPP_TOKEN_POSITION,
            maximumTokenCost: BigInt(options.tokenPayment.maximumTokenCost),
          }
        : await this.resolveTokenPayment(contractId, documentType, ownerId);
      const tokenPaymentInfo = paymentOptions ? new TokenPaymentInfo(paymentOptions) : undefined;
      if (paymentOptions) {
        logger.debug(`Attaching tokenPaymentInfo for ${documentType}: maxCost=${paymentOptions.maximumTokenCost} gasFeesPaidBy=${paymentOptions.gasFeesPaidBy ?? 0}`);
      }
      const actionFeeAgreement = await this.resolveActionFeeAgreement(sdk, contractId, documentType, 'create');

      // The transition re-derives the id from the document's entropy and this
      // nonce (wasm-dpp2, beta.4) and writes it back onto `document` — the id
      // derived above, and the one consensus recomputes.
      const createTransition = new DocumentCreateTransition({
        document,
        identityContractNonce: newNonce,
        ...(tokenPaymentInfo ? { tokenPaymentInfo } : {}),
        ...(actionFeeAgreement ? { actionFeeAgreement } : {}),
      });

      // Wrap in a BatchTransition
      const docTransition = createTransition.toDocumentTransition();
      const batched = new BatchedTransition(docTransition);
      const batchTransition = BatchTransition.fromBatchedTransitions(
        [batched],
        ownerId,
        0  // userFeeIncrease
      );

      // Convert to StateTransition for signing and broadcasting
      const stateTransition = batchTransition.toStateTransition();

      // Set the identity contract nonce on the ST
      stateTransition.setIdentityContractNonce(newNonce);

      // Sign the state transition
      const privateKey = PrivateKey.fromWIF(privateKeyWif);
      stateTransition.sign(privateKey, identityKey);
      logger.debug('StateTransition built and signed');

      // Cache the signed ST bytes BEFORE broadcasting (strict mode only — the
      // replay flow depends on get-by-id probes affectedState mode cannot make;
      // an indexOnly duplicate is instead rejected structurally, 40105).
      if (!affectedStateMode) {
        const stBytes = stateTransition.toBytes();
        if (stBytes instanceof Uint8Array) {
          savePendingSTBytes(documentId, stBytes);
        } else {
          // toBytes() might return ArrayBuffer or similar
          savePendingSTBytes(documentId, new Uint8Array(stBytes));
        }
        logger.debug(`Cached ${stBytes.byteLength ?? stBytes.length} ST bytes for ${documentId}`);
      }

      try {
        await sdk.stateTransitions.broadcastStateTransition(stateTransition);
        logger.debug('Broadcast succeeded, waiting for confirmation...');
      } catch (broadcastErr) {
        if (!affectedStateMode && isAlreadyExistsError(broadcastErr)) {
          // Race condition: another broadcast landed first
          const doc = await this.checkDocumentExists(contractId, documentType, documentId);
          if (doc) {
            clearPendingSTBytes(documentId);
            return { success: true, transactionHash: documentId, document: doc, confirmed: true };
          }
        }
        throw broadcastErr;
      }

      // The SDK auto-retries the wait on deadline exceeded.
      // indexOnly transitions never resolve as ExecutionProved — their proof is an
      // affected-state snapshot — so affectedState mode waits with the method
      // that accepts that outcome instead of failing a write that landed.
      try {
        const waited = affectedStateMode
          ? await sdk.stateTransitions.waitForAffectedState(stateTransition)
          : await sdk.stateTransitions.waitForResponse(stateTransition);
        logger.debug(`Document ${documentId} confirmed`);
        recordOwnerBalance(ownerId, waited);
        clearPendingSTBytes(documentId);
        // Refresh the SDK's internal nonce cache since we manually managed the nonce.
        // Without this, subsequent operations using the high-level API (e.g. delete)
        // would use a stale cached nonce.
        try {
          await wasm.refreshIdentityNonce(new Identifier(ownerId));
        } catch (refreshErr) {
          logger.warn('Failed to refresh nonce cache:', refreshErr);
        }
      } catch (waitErr) {
        if (isTimeoutError(waitErr)) {
          logger.warn(`waitForResponse timed out for ${documentId} — ST bytes cached for retry`);
          // Check Platform in case it landed despite timeout
          let doc = null;
          try { doc = await this.checkDocumentExists(contractId, documentType, documentId); } catch (checkErr) {
            logger.warn(`checkDocumentExists failed for ${documentId}:`, extractErrorMessage(checkErr));
          }
          if (doc) {
            clearPendingSTBytes(documentId);
            return { success: true, transactionHash: documentId, document: doc, confirmed: true };
          }
          // Leave ST bytes cached for next retry — don't throw yet, return optimistic success
          // since broadcast succeeded and the ST is valid
          try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
          return { success: true, transactionHash: documentId, document: resultDocument, confirmed: false };
        }
        if (isAlreadyExistsError(waitErr)) {
          let doc = null;
          try { doc = await this.checkDocumentExists(contractId, documentType, documentId); } catch (checkErr) {
            logger.warn(`checkDocumentExists failed for ${documentId}:`, extractErrorMessage(checkErr));
          }
          clearPendingSTBytes(documentId);
          try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
          return {
            success: true,
            transactionHash: documentId,
            document: doc || resultDocument,
            confirmed: Boolean(doc)
          };
        }
        // Non-fatal verification errors (e.g. newly deployed contract not yet propagated
        // to all nodes). Broadcast succeeded, so check Platform then return optimistic success.
        if (isNonFatalWaitError(waitErr)) {
          logger.warn(`waitForResponse hit non-fatal error for ${documentId}: ${extractErrorMessage(waitErr)}`);
          let doc = null;
          try { doc = await this.checkDocumentExists(contractId, documentType, documentId); } catch (checkErr) {
            logger.warn(`checkDocumentExists failed for ${documentId}:`, extractErrorMessage(checkErr));
          }
          if (doc) {
            clearPendingSTBytes(documentId);
            return { success: true, transactionHash: documentId, document: doc, confirmed: true };
          }
          try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
          return { success: true, transactionHash: documentId, document: resultDocument, confirmed: false };
        }
        throw waitErr;
      }

      // Cleanup old entries periodically
      cleanupOldPendingSTs();

      return { success: true, transactionHash: documentId, document: resultDocument, confirmed: true };
    } catch (error) {
      // The epoch multiplier outran the tolerance the agreement allowed: the
      // known value is stale, so the next write re-reads it. Not retried here
      // (a paid refusal bumped the nonce; the caller decides).
      if (isFeeMultiplierNotToleratedError(error)) knownFeeMultiplierPermille = null;
      logger.error('Error creating document:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }

  /**
   * Update a document using the typed API.
   * `documentData` should already use `Uint8Array` for binary fields.
   */
  async updateDocument(
    contractId: string,
    documentType: string,
    documentId: string,
    ownerId: string,
    documentData: Record<string, unknown>,
    revision: number
  ): Promise<StateTransitionResult> {
    try {
      this.assertUnpricedAction(contractId, documentType, 'replace');
      const sdk = await getEvoSdk();
      const privateKey = await this.getPrivateKey(ownerId);

      logger.debug(`Updating ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.debug(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const newRevision = revision + 1;
      const document = await documentBuilderService.buildDocumentForReplace(
        contractId,
        documentType,
        documentId,
        ownerId,
        documentData,
        newRevision
      );
      logger.debug('Built document for replacement');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.replace({ document, identityKey: signingKey, signer });
      logger.debug('Document update submitted successfully');

      return {
        success: true,
        transactionHash: documentId,
        document: {
          $id: documentId,
          $ownerId: ownerId,
          $type: documentType,
          $revision: newRevision,
          ...documentData
        }
      };
    } catch (error) {
      logger.error('Error updating document:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }

  /**
   * Delete a document using the typed API
   */
  async deleteDocument(
    contractId: string,
    documentType: string,
    documentId: string,
    ownerId: string
  ): Promise<StateTransitionResult> {
    try {
      this.assertUnpricedAction(contractId, documentType, 'delete');
      const sdk = await getEvoSdk();
      const privateKey = await this.getPrivateKey(ownerId);

      logger.debug(`Deleting ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.debug(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const documentForDelete = documentBuilderService.buildDocumentForDelete(
        contractId,
        documentType,
        documentId,
        ownerId
      );
      logger.debug('Built document identifier for deletion');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.delete({ document: documentForDelete, identityKey: signingKey, signer });
      logger.debug('Document deletion submitted successfully');

      return {
        success: true,
        transactionHash: documentId
      };
    } catch (error) {
      logger.error('Error deleting document:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }

  /**
   * Delete an **indexOnly** document by its full value tuple.
   *
   * indexOnly doctypes (v9 `like`/`likeReply`) store nothing under the document
   * id — the index entries ARE the rows — so the identifier-only delete path is
   * useless there. Drive instead needs every property value plus the consensus
   * `$createdAt` to recompute and remove each index entry, which means the
   * delete must be handed a fully-populated Document (the from_document /
   * index-only-delete route in the SDK), the call shape the social batteries
   * prove live on moutai.
   *
   * indexOnly transitions never resolve as `ExecutionProved`, so the facade's
   * internal wait can fail after a broadcast that landed; the transient wait
   * signatures return optimistic success (`confirmed: false`) here, and callers
   * that must know re-read the liked state off the chain.
   */
  async deleteDocumentByValues(
    contractId: string,
    documentType: string,
    ownerId: string,
    tuple: {
      /** The document id to put on the transition ($id from a covering query projection). */
      documentId: string;
      /** The consensus `$createdAt` (ms) recovered from a covering index projection. */
      createdAtMs: number;
      /** Every content property, with identifier fields as raw `Uint8Array` bytes. */
      data: Record<string, unknown>;
    }
  ): Promise<StateTransitionResult> {
    const { documentId, createdAtMs, data } = tuple;
    try {
      this.assertUnpricedAction(contractId, documentType, 'delete');
      const sdk = await getEvoSdk();
      const privateKeyWif = await this.getPrivateKey(ownerId);

      logger.debug(`Deleting ${documentType} by values (indexOnly): ${documentId}`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const identityKey = this.findMatchingSigningKey(privateKeyWif, identity.publicKeys);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      const document = await documentBuilderService.buildDocumentForValuesDelete(
        contractId,
        documentType,
        documentId,
        ownerId,
        data,
        createdAtMs
      );

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKeyWif,
        identityKey
      );

      try {
        await sdk.documents.delete({ document, identityKey: signingKey, signer });
        logger.debug(`indexOnly delete ${documentId} confirmed`);
      } catch (waitErr) {
        if (!isTimeoutError(waitErr) && !isNonFatalWaitError(waitErr) && !isAlreadyExistsError(waitErr)) {
          throw waitErr;
        }
        logger.warn(`Delete-by-values wait unresolved for ${documentId} — assuming success:`, extractErrorMessage(waitErr));
        return { success: true, transactionHash: documentId, confirmed: false };
      }

      return { success: true, transactionHash: documentId, confirmed: true };
    } catch (error) {
      logger.error('Error deleting document by values:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }
}

// Singleton instance
export const stateTransitionService = new StateTransitionService();
