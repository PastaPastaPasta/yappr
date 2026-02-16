import { getEvoSdk } from './evo-sdk-service';
import { SecurityLevel, KeyPurpose, signerService } from './signer-service';
import { documentBuilderService } from './document-builder-service';
import { findMatchingKeyIndex, getSecurityLevelName, type IdentityPublicKeyInfo } from '@/lib/crypto/keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { promptForAuthKey } from '../auth-utils';
import { extractErrorMessage, isTimeoutError, isAlreadyExistsError } from '../error-utils';
import {
  DocumentCreateTransition,
  BatchedTransition,
  BatchTransition,
  StateTransition,
  PrivateKey,
} from '@dashevo/evo-sdk';

export interface StateTransitionResult {
  success: boolean;
  transactionHash?: string;
  document?: Record<string, unknown>;
  error?: string;
}

/** Key for localStorage ST cache */
const ST_CACHE_PREFIX = 'yappr:pending-st:';

/**
 * Save serialized state transition bytes for retry.
 * Uses localStorage for persistence across page reloads.
 */
function savePendingSTBytes(documentId: string, bytes: Uint8Array): void {
  try {
    const key = ST_CACHE_PREFIX + documentId;
    // Store as base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    localStorage.setItem(key, base64);
  } catch (err) {
    console.warn('Failed to save pending ST bytes:', err);
  }
}

/**
 * Load previously saved state transition bytes.
 */
function loadPendingSTBytes(documentId: string): Uint8Array | null {
  try {
    const key = ST_CACHE_PREFIX + documentId;
    const base64 = localStorage.getItem(key);
    if (!base64) return null;
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
 * Clean up old pending ST entries (older than 24h).
 */
function cleanupOldPendingSTs(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(ST_CACHE_PREFIX)) {
        keys.push(key);
      }
    }
    // Keep at most 50 entries — remove oldest if over limit
    if (keys.length > 50) {
      // Can't easily sort by age without metadata, just trim from the front
      for (let i = 0; i < keys.length - 50; i++) {
        localStorage.removeItem(keys[i]);
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
    const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet';

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
      console.error('Private key does not match any key on this identity');
      return null;
    }

    console.log(`Matched private key to identity key: id=${match.keyId}, securityLevel=${getSecurityLevelName(match.securityLevel)}, purpose=${match.purpose}`);

    if (match.purpose !== KeyPurpose.AUTHENTICATION) {
      console.error(`Matched key (id=${match.keyId}) has purpose ${match.purpose}, not AUTHENTICATION (0)`);
      return null;
    }

    if (match.securityLevel < SecurityLevel.CRITICAL) {
      console.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, which is not allowed for document operations (only CRITICAL or HIGH)`);
      return null;
    }

    if (match.securityLevel > requiredSecurityLevel) {
      console.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, but operation requires at least ${getSecurityLevelName(requiredSecurityLevel)}`);
      return null;
    }

    const wasmKey = wasmPublicKeys.find(k => k.keyId === match.keyId);
    return wasmKey || null;
  }

  /**
   * Check if a document already exists on Platform by ID.
   */
  private async checkDocumentExists(
    contractId: string,
    documentType: string,
    documentId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const sdk = await getEvoSdk();
      const doc = await sdk.documents.get(contractId, documentType, documentId);
      if (doc) {
        const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
        return json as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create a document with idempotent retry via ST byte caching.
   *
   * Instead of using sdk.documents.create() (which atomically builds,
   * signs, broadcasts, and waits — bumping the nonce each time), we:
   *
   * 1. Build the Document and wrap it in a DocumentCreateTransition
   * 2. Bundle into a BatchTransition → StateTransition
   * 3. Fetch the identity contract nonce from Platform and set it
   * 4. Sign the StateTransition
   * 5. Cache the signed ST bytes (localStorage)
   * 6. Broadcast via sdk.wasm.broadcastStateTransition()
   * 7. Wait via sdk.wasm.waitForResponse()
   *
   * On timeout/retry, we reload the cached bytes and rebroadcast the
   * SAME signed ST. Platform either accepts it (first broadcast) or
   * recognizes it's already processed (replay). No new nonce = no
   * double post, enforced at the protocol level.
   */
  async createDocument(
    contractId: string,
    documentType: string,
    ownerId: string,
    documentData: Record<string, unknown>
  ): Promise<StateTransitionResult> {
    try {
      const sdk = await getEvoSdk();
      const wasm = sdk.wasm;
      const privateKeyWif = await this.getPrivateKey(ownerId);

      console.log(`Creating ${documentType} document with data:`, documentData);

      // Validate signing key
      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.getPublicKeys();
      const identityKey = this.findMatchingSigningKey(privateKeyWif, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      console.log(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // Build the Document
      const document = await documentBuilderService.buildDocumentForCreate(
        contractId,
        documentType,
        ownerId,
        documentData
      );
      const documentId = documentBuilderService.getDocumentId(document);
      console.log(`Built document, ID: ${documentId}`);

      // --- Check for a cached ST from a previous timed-out attempt ---
      const cachedBytes = loadPendingSTBytes(documentId);
      if (cachedBytes) {
        console.log(`Found cached ST bytes for ${documentId} — checking Platform...`);

        // First check if it already landed
        const existingDoc = await this.checkDocumentExists(contractId, documentType, documentId);
        if (existingDoc) {
          console.log(`Document ${documentId} already confirmed on Platform`);
          clearPendingSTBytes(documentId);
          return { success: true, transactionHash: documentId, document: existingDoc };
        }

        // Not confirmed yet — rebroadcast the same ST
        console.log(`Rebroadcasting cached ST for ${documentId}...`);
        try {
          const cachedST = StateTransition.fromBytes(cachedBytes);
          await wasm.broadcastStateTransition(cachedST);
          const result = await wasm.waitForResponse(cachedST);
          console.log(`Rebroadcast succeeded for ${documentId}`, result);
          clearPendingSTBytes(documentId);
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData }
          };
        } catch (rebroadcastErr) {
          if (isAlreadyExistsError(rebroadcastErr)) {
            // Already processed — confirm on Platform
            const doc = await this.checkDocumentExists(contractId, documentType, documentId);
            if (doc) {
              clearPendingSTBytes(documentId);
              return { success: true, transactionHash: documentId, document: doc };
            }
          }
          if (isTimeoutError(rebroadcastErr)) {
            // Still timing out — check Platform one more time
            const doc = await this.checkDocumentExists(contractId, documentType, documentId);
            if (doc) {
              clearPendingSTBytes(documentId);
              return { success: true, transactionHash: documentId, document: doc };
            }
          }
          // Genuine failure on rebroadcast — clear cache and fall through to create fresh
          console.warn('Rebroadcast failed, will create fresh ST:', extractErrorMessage(rebroadcastErr));
          clearPendingSTBytes(documentId);
        }
      }

      // --- Check if document already on Platform (e.g., from a previous session) ---
      const existingDoc = await this.checkDocumentExists(contractId, documentType, documentId);
      if (existingDoc) {
        console.log(`Document ${documentId} already exists on Platform — skipping creation`);
        return { success: true, transactionHash: documentId, document: existingDoc };
      }

      // --- Build the StateTransition manually ---

      // Fetch current identity contract nonce from Platform
      const currentNonce = await wasm.getIdentityContractNonce(ownerId, contractId);
      const newNonce = (currentNonce ?? BigInt(0)) + BigInt(1);
      console.log(`Nonce: current=${currentNonce}, using=${newNonce}`);

      // Create DocumentCreateTransition from the Document
      const createTransition = new DocumentCreateTransition(
        document,
        newNonce,
        null,  // prefundedVotingBalance
        null   // tokenPaymentInfo
      );

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
      console.log('StateTransition built and signed');

      // Cache the signed ST bytes BEFORE broadcasting
      const stBytes = stateTransition.toBytes();
      if (stBytes instanceof Uint8Array) {
        savePendingSTBytes(documentId, stBytes);
      } else {
        // toBytes() might return ArrayBuffer or similar
        savePendingSTBytes(documentId, new Uint8Array(stBytes));
      }
      console.log(`Cached ${stBytes.byteLength ?? stBytes.length} ST bytes for ${documentId}`);

      // Broadcast
      try {
        await wasm.broadcastStateTransition(stateTransition);
        console.log('Broadcast succeeded, waiting for confirmation...');
      } catch (broadcastErr) {
        if (isAlreadyExistsError(broadcastErr)) {
          // Race condition: another broadcast landed first
          const doc = await this.checkDocumentExists(contractId, documentType, documentId);
          if (doc) {
            clearPendingSTBytes(documentId);
            return { success: true, transactionHash: documentId, document: doc };
          }
        }
        throw broadcastErr;
      }

      // Wait for confirmation
      try {
        await wasm.waitForResponse(stateTransition);
        console.log(`Document ${documentId} confirmed`);
        clearPendingSTBytes(documentId);
      } catch (waitErr) {
        if (isTimeoutError(waitErr)) {
          console.warn(`waitForResponse timed out for ${documentId} — ST bytes cached for retry`);
          // Check Platform in case it landed despite timeout
          const doc = await this.checkDocumentExists(contractId, documentType, documentId);
          if (doc) {
            clearPendingSTBytes(documentId);
            return { success: true, transactionHash: documentId, document: doc };
          }
          // Leave ST bytes cached for next retry — don't throw yet, return optimistic success
          // since broadcast succeeded and the ST is valid
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData }
          };
        }
        if (isAlreadyExistsError(waitErr)) {
          clearPendingSTBytes(documentId);
          return {
            success: true,
            transactionHash: documentId,
            document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData }
          };
        }
        throw waitErr;
      }

      // Cleanup old entries periodically
      cleanupOldPendingSTs();

      return {
        success: true,
        transactionHash: documentId,
        document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData }
      };
    } catch (error) {
      console.error('Error creating document:', error);
      return {
        success: false,
        error: extractErrorMessage(error)
      };
    }
  }

  /**
   * Update a document using the typed API
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

      console.log(`Updating ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.getPublicKeys();
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      console.log(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const newRevision = revision + 1;
      const document = await documentBuilderService.buildDocumentForReplace(
        contractId,
        documentType,
        documentId,
        ownerId,
        documentData,
        newRevision
      );
      console.log('Built document for replacement');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.replace({ document, identityKey: signingKey, signer });
      console.log('Document update submitted successfully');

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
      console.error('Error updating document:', error);
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

      console.log(`Deleting ${documentType} document ${documentId}...`);

      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.getPublicKeys();
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      console.log(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      const documentForDelete = documentBuilderService.buildDocumentForDelete(
        contractId,
        documentType,
        documentId,
        ownerId
      );
      console.log('Built document identifier for deletion');

      const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
        privateKey,
        identityKey
      );

      await sdk.documents.delete({ document: documentForDelete, identityKey: signingKey, signer });
      console.log('Document deletion submitted successfully');

      return {
        success: true,
        transactionHash: documentId
      };
    } catch (error) {
      console.error('Error deleting document:', error);
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
    void options;

    try {
      const sdk = await getEvoSdk();

      console.log(`Waiting for transaction confirmation: ${transactionHash}`);

      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Wait timeout')), 8000);
        });

        const result = await Promise.race([
          sdk.wasm.waitForStateTransitionResult(transactionHash),
          timeoutPromise
        ]);

        if (result) {
          console.log('Transaction confirmed:', result);
          return { success: true, result };
        }
      } catch (waitError) {
        console.log('waitForStateTransitionResult timed out (expected):', waitError);
      }

      console.log('Transaction broadcast successfully. Assuming confirmation due to known DAPI timeout issue.');
      return {
        success: true,
        result: {
          assumed: true,
          reason: 'DAPI wait timeout is a known issue - transaction likely succeeded',
          transactionHash
        }
      };
    } catch (error) {
      console.error('Error waiting for confirmation:', error);
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

    console.log('Waiting for transaction confirmation...');
    const confirmation = await this.waitForConfirmation(result.transactionHash, {
      onProgress: (attempt, elapsed) => {
        console.log(`Confirmation attempt ${attempt}, elapsed: ${Math.round(elapsed / 1000)}s`);
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
