import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { getEvoSdk } from './evo-sdk-service';
import { SecurityLevel, KeyPurpose, signerService } from './signer-service';
import { documentBuilderService } from './document-builder-service';
import { findMatchingKeyIndex, getSecurityLevelName, type IdentityPublicKeyInfo } from '@/lib/crypto/keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { promptForAuthKey } from '../auth-utils';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_COSTS, YAPP_TOKEN_POSITION, keyNetwork } from '../constants';
import { extractErrorMessage, isTimeoutError, isAlreadyExistsError, isNonFatalWaitError } from '../error-utils';
import { documentToPlainObject } from './sdk-helpers';
import {
  DocumentCreateTransition,
  BatchedTransition,
  BatchTransition,
  StateTransition,
  PrivateKey,
  Identifier,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk';


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
 * Save serialized state transition bytes for retry.
 * Uses localStorage for persistence across page reloads.
 */
function savePendingSTBytes(documentId: string, bytes: Uint8Array): void {
  try {
    const key = ST_CACHE_PREFIX + documentId;
    // Store as base64 with timestamp
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const entry: CachedSTEntry = {
      data: btoa(binary),
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

    // Support both legacy (plain base64) and new (JSON with timestamp) formats
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

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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

      // Evict entries older than 24h (or legacy entries without timestamp)
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
   * Find the WASM identity public key that matches the stored private key.
   */
  private findMatchingSigningKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    requiredSecurityLevel: number = SecurityLevel.HIGH
  ): WasmIdentityPublicKey | null {
    const network = keyNetwork();

    const keyInfos: IdentityPublicKeyInfo[] = wasmPublicKeys.map(key => {
      const dataHex = key.data;
      const data = new Uint8Array(dataHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);

      return {
        id: key.keyId,
        type: key.keyTypeNumber,
        purpose: key.purposeNumber,
        securityLevel: key.securityLevelNumber,
        data
      };
    });

    const match = findMatchingKeyIndex(privateKeyWif, keyInfos, network);

    if (!match) {
      logger.error('Private key does not match any key on this identity');
      return null;
    }

    logger.info(`Matched private key to identity key: id=${match.keyId}, securityLevel=${getSecurityLevelName(match.securityLevel)}, purpose=${match.purpose}`);

    if (match.purpose !== KeyPurpose.AUTHENTICATION) {
      logger.error(`Matched key (id=${match.keyId}) has purpose ${match.purpose}, not AUTHENTICATION (0)`);
      return null;
    }

    if (match.securityLevel < SecurityLevel.CRITICAL) {
      logger.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, which is not allowed for document operations (only CRITICAL or HIGH)`);
      return null;
    }

    if (match.securityLevel > requiredSecurityLevel) {
      logger.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, but operation requires at least ${getSecurityLevelName(requiredSecurityLevel)}`);
      return null;
    }

    const wasmKey = wasmPublicKeys.find(k => k.keyId === match.keyId);
    return wasmKey || null;
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
   * Create a document with idempotent retry via ST byte caching.
   *
   * This is the typed write path: `documentData` should already use `Uint8Array` for binary
   * fields before it is wrapped in a `Document`.
   *
   * Instead of using sdk.documents.create() (which atomically builds,
   * signs, broadcasts, and waits — bumping the nonce each time), we:
   *
   * 1. Build the Document and wrap it in a DocumentCreateTransition
   * 2. Bundle into a BatchTransition → StateTransition
   * 3. Fetch the identity contract nonce from Platform and set it
   * 4. Sign the StateTransition
   * 5. Cache the signed ST bytes (localStorage)
   * 6. Broadcast via sdk.stateTransitions.broadcastStateTransition()
   * 7. Wait via sdk.stateTransitions.waitForResponse()
   *
   * On timeout/retry, we reload the cached bytes and rebroadcast the
   * SAME signed ST. Platform either accepts it (first broadcast) or
   * recognizes it's already processed (replay). No new nonce = no
   * double post, enforced at the protocol level.
   */
  /**
   * Resolve the automatic token-payment agreement for a token-paid document type
   * on the v2 social contract (post/reply/like/repost). Returns undefined for
   * free document types or documents on other contracts.
   */
  private resolveTokenPayment(
    contractId: string,
    documentType: string
  ): { tokenContractPosition?: number; maximumTokenCost: number } | undefined {
    if (contractId !== YAPPR_CONTRACT_ID) return undefined;
    const amount = (YAPP_TOKEN_COSTS as Record<string, number>)[documentType];
    if (!amount) return undefined;
    return { maximumTokenCost: amount };
  }

  async createDocument(
    contractId: string,
    documentType: string,
    ownerId: string,
    documentData: Record<string, unknown>,
    options?: {
      documentId?: string;
      entropy?: Uint8Array;
      /**
       * Token payment agreement for document types that declare a tokenCost.create
       * (e.g. post/reply/like/repost). `maximumTokenCost` is the cap the user agrees
       * to spend — set it to the contract's declared amount to guard against price
       * changes. Token position defaults to 0 (the YAPP token).
       */
      tokenPayment?: {
        tokenContractPosition?: number;
        maximumTokenCost: number;
      };
      /**
       * How to confirm the transition. `'strict'` (default) is the historical
       * path: `waitForResponse` plus get-by-id existence probes and ST-byte
       * caching for idempotent rebroadcast.
       *
       * `'affectedState'` is for **indexOnly** document types (v4 likes): those
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

      logger.info(`Creating ${documentType} document with data:`, documentData);

      // Validate signing key
      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKeyWif, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.info(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // Build the typed Document. Binary fields remain Uint8Array on this path.
      const document = await documentBuilderService.buildDocumentForCreate(
        contractId,
        documentType,
        ownerId,
        documentData,
        {
          id: options?.documentId,
          entropy: options?.entropy,
        }
      );
      const documentId = documentBuilderService.getDocumentId(document);
      logger.info(`Built document, ID: ${documentId}`);

      // --- Check for a cached ST from a previous timed-out attempt ---
      // Meaningless in affectedState mode: the replay flow settles through
      // get-by-id probes an indexOnly doctype cannot answer.
      const cachedBytes = affectedStateMode ? null : loadPendingSTBytes(documentId);
      if (cachedBytes) {
        logger.info(`Found cached ST bytes for ${documentId} — checking Platform...`);

        // First check if it already landed
        const existingDoc = await this.checkDocumentExists(contractId, documentType, documentId);
        if (existingDoc) {
          logger.info(`Document ${documentId} already confirmed on Platform`);
          clearPendingSTBytes(documentId);
          return { success: true, transactionHash: documentId, document: existingDoc, confirmed: true };
        }

        // Not confirmed yet — rebroadcast the same ST
        logger.info(`Rebroadcasting cached ST for ${documentId}...`);
        try {
          const cachedST = StateTransition.fromBytes(cachedBytes);
          // v3.1: Use StateTransitionsFacade instead of direct wasm access
          await sdk.stateTransitions.broadcastStateTransition(cachedST);
          const result = await sdk.stateTransitions.waitForResponse(cachedST);
          logger.info(`Rebroadcast succeeded for ${documentId}`, result);
          clearPendingSTBytes(documentId);
          try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
            confirmed: true
          };
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
          // Genuine failure on rebroadcast — clear cache and fall through to create fresh
          logger.warn('Rebroadcast failed, will create fresh ST:', extractErrorMessage(rebroadcastErr));
          clearPendingSTBytes(documentId);
        }
      }

      // --- Check if document already on Platform (e.g., from a previous session) ---
      if (!affectedStateMode) {
        const existingDoc = await this.checkDocumentExists(contractId, documentType, documentId);
        if (existingDoc) {
          logger.info(`Document ${documentId} already exists on Platform — skipping creation`);
          return { success: true, transactionHash: documentId, document: existingDoc, confirmed: true };
        }
      }

      // --- Build the StateTransition manually ---

      // Fetch current identity contract nonce from Platform
      // DIP-30: nonce is u64 where lower 40 bits = sequence number,
      // upper 24 bits = missing revision bitset. Only increment the sequence part.
      const SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1); // 0xFFFFFFFFFF
      // v3.1: getIdentityContractNonce returns bigint | undefined (was bigint | null)
      const currentNonce = await wasm.getIdentityContractNonce(ownerId, contractId);
      const rawNonce = currentNonce ?? BigInt(0);
      const sequenceNumber = rawNonce & SEQUENCE_MASK;
      const newNonce = sequenceNumber + BigInt(1);
      logger.info(`Nonce: current=${currentNonce}, sequence=${sequenceNumber}, using=${newNonce}`);

      // Build the token payment agreement for token-paid document types
      // (post/reply/like/repost on the v2 social contract). Callers may pass an
      // explicit `options.tokenPayment`; otherwise we auto-attach based on the
      // document type's declared tokenCost so every write path is covered. The
      // signed bytes that include this are cached below, so the rebroadcast path
      // above replays the same agreement verbatim.
      const effectivePayment = options?.tokenPayment ?? this.resolveTokenPayment(contractId, documentType);
      let tokenPaymentInfo: TokenPaymentInfo | undefined;
      if (effectivePayment) {
        tokenPaymentInfo = new TokenPaymentInfo({
          tokenContractPosition: effectivePayment.tokenContractPosition ?? YAPP_TOKEN_POSITION,
          maximumTokenCost: BigInt(effectivePayment.maximumTokenCost),
        });
        logger.info(`Attaching tokenPaymentInfo for ${documentType}: maxCost=${effectivePayment.maximumTokenCost}`);
      }

      // v3.1: DocumentCreateTransition takes an options object
      const createTransition = new DocumentCreateTransition({
        document,
        identityContractNonce: newNonce,
        ...(tokenPaymentInfo ? { tokenPaymentInfo } : {}),
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
      logger.info('StateTransition built and signed');

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
        logger.info(`Cached ${stBytes.byteLength ?? stBytes.length} ST bytes for ${documentId}`);
      }

      // Broadcast via StateTransitionsFacade (v3.1)
      try {
        await sdk.stateTransitions.broadcastStateTransition(stateTransition);
        logger.info('Broadcast succeeded, waiting for confirmation...');
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

      // Wait for confirmation via StateTransitionsFacade (v3.1)
      // SDK v3.1 returns typed StateTransitionProofResultType and auto-retries on deadline exceeded.
      // indexOnly transitions never resolve as ExecutionProved — their proof is an
      // affected-state snapshot — so affectedState mode waits with the method
      // that accepts that outcome instead of failing a write that landed.
      try {
        if (affectedStateMode) {
          await sdk.stateTransitions.waitForAffectedState(stateTransition);
        } else {
          await sdk.stateTransitions.waitForResponse(stateTransition);
        }
        logger.info(`Document ${documentId} confirmed`);
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
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
            confirmed: false
          };
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
            document: doc || { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
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
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
            confirmed: false
          };
        }
        throw waitErr;
      }

      // Cleanup old entries periodically
      cleanupOldPendingSTs();

      return {
        success: true,
        transactionHash: documentId,
        document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
        confirmed: true
      };
    } catch (error) {
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
      const sdk = await getEvoSdk();
      const privateKey = await this.getPrivateKey(ownerId);

      logger.info(`Updating ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.info(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const newRevision = revision + 1;
      const document = await documentBuilderService.buildDocumentForReplace(
        contractId,
        documentType,
        documentId,
        ownerId,
        documentData,
        newRevision
      );
      logger.info('Built document for replacement');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.replace({ document, identityKey: signingKey, signer });
      logger.info('Document update submitted successfully');

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
      const sdk = await getEvoSdk();
      const privateKey = await this.getPrivateKey(ownerId);

      logger.info(`Deleting ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.publicKeys;
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      logger.info(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const documentForDelete = documentBuilderService.buildDocumentForDelete(
        contractId,
        documentType,
        documentId,
        ownerId
      );
      logger.info('Built document identifier for deletion');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.delete({ document: documentForDelete, identityKey: signingKey, signer });
      logger.info('Document deletion submitted successfully');

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
   * indexOnly doctypes (v4 `like`/`likeReply`) store nothing under the document
   * id — the index entries ARE the rows — so the identifier-only delete path is
   * useless there. Drive instead needs every property value plus the consensus
   * `$createdAt` to recompute and remove each index entry, which means the
   * delete must be handed a fully-populated Document (the from_document /
   * index-only-delete route in the SDK) — the exact call shape the v4 verify
   * battery (scripts/verify-v4.mjs, b8/b10/b11) proved live on moutai.
   *
   * indexOnly transitions never resolve as `ExecutionProved`, so the facade's
   * internal wait can fail after a broadcast that landed; the transient wait
   * signatures return optimistic success (`confirmed: false`) here, and callers
   * that must know re-read the liked state off the chain.
   */
  /**
   * Creates TWO documents in ONE batch transition — one nonce, one signature,
   * one broadcast — so the pair lands atomically or not at all. Built for the
   * v6 like + `beat` companion: a like of a tagged post must never exist
   * without its beat (a missing beat under-counts today's trending; a beat
   * without its like is a phantom vote), and one transition costs the beat's
   * bytes rather than a whole second state transition.
   *
   * Both documents are indexOnly, so confirmation is the affected-state wait
   * (an indexOnly transition never resolves as ExecutionProved) and, as with
   * `createDocument`'s affectedState mode, a post-broadcast throw is not
   * believed: callers re-check the chain through a value query.
   */
  async createDocumentPair(
    contractId: string,
    ownerId: string,
    documents: [
      { documentType: string; data: Record<string, unknown>; tokenPayment?: { tokenContractPosition?: number; maximumTokenCost: number } },
      { documentType: string; data: Record<string, unknown>; tokenPayment?: { tokenContractPosition?: number; maximumTokenCost: number } },
    ]
  ): Promise<StateTransitionResult> {
    try {
      const sdk = await getEvoSdk();
      const wasm = sdk.wasm;
      const privateKeyWif = await this.getPrivateKey(ownerId);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) throw new Error('Identity not found');
      const identityKey = this.findMatchingSigningKey(privateKeyWif, identity.publicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      const SEQUENCE_MASK = (BigInt(1) << BigInt(40)) - BigInt(1);
      const currentNonce = await wasm.getIdentityContractNonce(ownerId, contractId);
      const sequenceNumber = (currentNonce ?? BigInt(0)) & SEQUENCE_MASK;
      const newNonce = sequenceNumber + BigInt(1);

      const batched: InstanceType<typeof BatchedTransition>[] = [];
      const ids: string[] = [];
      for (const { documentType, data, tokenPayment } of documents) {
        const document = await documentBuilderService.buildDocumentForCreate(contractId, documentType, ownerId, data);
        ids.push(documentBuilderService.getDocumentId(document));
        const effectivePayment = tokenPayment ?? this.resolveTokenPayment(contractId, documentType);
        const tokenPaymentInfo = effectivePayment
          ? new TokenPaymentInfo({
              tokenContractPosition: effectivePayment.tokenContractPosition ?? YAPP_TOKEN_POSITION,
              maximumTokenCost: BigInt(effectivePayment.maximumTokenCost),
            })
          : undefined;
        const createTransition = new DocumentCreateTransition({
          document,
          identityContractNonce: newNonce,
          ...(tokenPaymentInfo ? { tokenPaymentInfo } : {}),
        });
        batched.push(new BatchedTransition(createTransition.toDocumentTransition()));
      }
      logger.info(`Creating ${documents.map((d) => d.documentType).join('+')} in one batch (nonce ${newNonce})`);

      const batchTransition = BatchTransition.fromBatchedTransitions(batched, ownerId, 0);
      const stateTransition = batchTransition.toStateTransition();
      stateTransition.setIdentityContractNonce(newNonce);
      stateTransition.sign(PrivateKey.fromWIF(privateKeyWif), identityKey);

      await sdk.stateTransitions.broadcastStateTransition(stateTransition);
      try {
        await sdk.stateTransitions.waitForAffectedState(stateTransition);
        logger.info(`Batch ${ids.join('+')} confirmed`);
      } catch (waitErr) {
        if (!isTimeoutError(waitErr) && !isNonFatalWaitError(waitErr) && !isAlreadyExistsError(waitErr)) throw waitErr;
        logger.warn(`Batch wait unresolved for ${ids.join('+')} — assuming success:`, extractErrorMessage(waitErr));
      }
      try { await wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
      return { success: true, transactionHash: ids[0], confirmed: false };
    } catch (error) {
      logger.error('Error creating document pair:', error);
      return { success: false, error: extractErrorMessage(error) };
    }
  }

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
      const sdk = await getEvoSdk();
      const privateKeyWif = await this.getPrivateKey(ownerId);

      logger.info(`Deleting ${documentType} by values (indexOnly): ${documentId}`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const identityKey = this.findMatchingSigningKey(privateKeyWif, identity.publicKeys, SecurityLevel.HIGH);
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
        logger.info(`indexOnly delete ${documentId} confirmed`);
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

  /**
   * Wait for a state transition to be confirmed
   */
  async waitForConfirmation(
    transactionHash: string,
    options: {
      maxWaitTimeMs?: number,
      onProgress?: (attempt: number, elapsed: number) => void
    } = {}
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const { maxWaitTimeMs = 8000, onProgress } = options;

    try {
      const sdk = await getEvoSdk();

      logger.info(`Waiting for transaction confirmation: ${transactionHash}`);
      onProgress?.(1, 0);

      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Wait timeout')), maxWaitTimeMs);
        });

        // v3.1: Use StateTransitionsFacade instead of direct wasm access
        const result = await Promise.race([
          sdk.stateTransitions.waitForStateTransitionResult(transactionHash),
          timeoutPromise
        ]);

        if (result) {
          logger.info('Transaction confirmed:', result);
          return { success: true, result };
        }
      } catch (waitError) {
        logger.info('waitForStateTransitionResult timed out (expected):', waitError);
      }

      logger.info('Transaction broadcast successfully. Assuming confirmation due to known DAPI timeout issue.');
      return {
        success: true,
        result: {
          assumed: true,
          reason: 'DAPI wait timeout is a known issue - transaction likely succeeded',
          transactionHash
        }
      };
    } catch (error) {
      logger.error('Error waiting for confirmation:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }

  /**
   * Create document with confirmation
   */
  async createDocumentWithConfirmation(
    contractId: string,
    documentType: string,
    ownerId: string,
    documentData: Record<string, unknown>,
    waitForConfirmation: boolean = false
  ): Promise<StateTransitionResult & { confirmed?: boolean }> {
    const result = await this.createDocument(contractId, documentType, ownerId, documentData);

    if (!result.success || !waitForConfirmation || !result.transactionHash) {
      return result;
    }

    logger.info('Waiting for transaction confirmation...');
    const confirmation = await this.waitForConfirmation(result.transactionHash, {
      onProgress: (attempt, elapsed) => {
        logger.info(`Confirmation attempt ${attempt}, elapsed: ${Math.round(elapsed / 1000)}s`);
      }
    });

    return {
      ...result,
      confirmed: confirmation.success
    };
  }
}

// Singleton instance
export const stateTransitionService = new StateTransitionService();
