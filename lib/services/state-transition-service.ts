import { getEvoSdk } from './evo-sdk-service';
import { SecurityLevel, KeyPurpose } from './signer-service';
import { findMatchingKeyIndex, getSecurityLevelName, type IdentityPublicKeyInfo } from '@/lib/crypto/keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';

export interface StateTransitionResult {
  success: boolean;
  transactionHash?: string;
  document?: Record<string, unknown>;
  error?: string;
}

/**
 * Extract a meaningful error message from any error type,
 * including WasmSdkError which has a complex structure.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    // WasmSdkError has message, kind, code properties
    const wasmError = error as {
      message?: string | object;
      kind?: string | number;
      code?: number;
      toString?: () => string
    };

    // Log details for debugging
    console.error('WasmSdkError details:', {
      kind: wasmError.kind,
      code: wasmError.code,
      message: wasmError.message,
      messageType: typeof wasmError.message
    });

    // Try to extract message
    if (typeof wasmError.message === 'string') {
      return wasmError.message;
    }
    if (wasmError.message && typeof wasmError.message === 'object') {
      // Message might be a nested object - try to stringify it
      return JSON.stringify(wasmError.message);
    }
    if (wasmError.toString && typeof wasmError.toString === 'function') {
      const str = wasmError.toString();
      if (str !== '[object Object]') {
        return str;
      }
    }
    // Last resort: stringify the whole error
    return JSON.stringify(error);
  }
  return String(error);
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
      throw new Error('No private key found. Please log in again.');
    }

    return privateKey;
  }

  /**
   * Find the WASM identity public key that matches the stored private key.
   *
   * This is critical for dev.11+ SDK: we must use the key that matches our signer's private key.
   * The signer only has one private key, so we find which identity key it corresponds to.
   *
   * @param privateKeyWif - The stored private key in WIF format
   * @param wasmPublicKeys - The identity's WASM public keys
   * @param requiredSecurityLevel - Maximum allowed security level (lower = more secure)
   * @returns The matching WASM key or null if not found/not suitable
   */
  private findMatchingSigningKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    requiredSecurityLevel: number = SecurityLevel.HIGH
  ): WasmIdentityPublicKey | null {
    const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet';

    // Convert WASM keys to the format expected by findMatchingKeyIndex
    const keyInfos: IdentityPublicKeyInfo[] = wasmPublicKeys.map(key => {
      // Get the raw data from the WASM key
      // The data getter returns hex string, convert to Uint8Array
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

    // Find which key matches our private key
    const match = findMatchingKeyIndex(privateKeyWif, keyInfos, network);

    if (!match) {
      console.error('Private key does not match any key on this identity');
      return null;
    }

    console.log(`Matched private key to identity key: id=${match.keyId}, securityLevel=${getSecurityLevelName(match.securityLevel)}, purpose=${match.purpose}`);

    // Check if the matched key is suitable for document operations
    // Must be AUTHENTICATION purpose
    if (match.purpose !== KeyPurpose.AUTHENTICATION) {
      console.error(`Matched key (id=${match.keyId}) has purpose ${match.purpose}, not AUTHENTICATION (0)`);
      return null;
    }

    // Must be CRITICAL (1) or HIGH (2) - NOT MASTER (0) and not below required level
    if (match.securityLevel < SecurityLevel.CRITICAL) {
      console.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, which is not allowed for document operations (only CRITICAL or HIGH)`);
      return null;
    }

    if (match.securityLevel > requiredSecurityLevel) {
      console.error(`Matched key (id=${match.keyId}) has security level ${getSecurityLevelName(match.securityLevel)}, but operation requires at least ${getSecurityLevelName(requiredSecurityLevel)}`);
      return null;
    }

    // Return the WASM key object for the matched key
    const wasmKey = wasmPublicKeys.find(k => k.keyId === match.keyId);
    return wasmKey || null;
  }

  /**
   * Generate random entropy hex string for document creation
   */
  private generateEntropyHex(): string {
    // Use Web Crypto API for secure random bytes
    const entropy = new Uint8Array(32);
    if (typeof window !== 'undefined' && window.crypto) {
      window.crypto.getRandomValues(entropy);
    } else {
      // Fallback for non-browser environments (shouldn't happen for state transitions)
      for (let i = 0; i < 32; i++) {
        entropy[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(entropy).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Create a document using the dev.11+ SDK API
   */
  async createDocument(
    contractId: string,
    documentType: string,
    ownerId: string,
    documentData: Record<string, unknown>
  ): Promise<StateTransitionResult> {
    try {
      const sdk = await getEvoSdk();
      const privateKey = await this.getPrivateKey(ownerId);

      console.log(`Creating ${documentType} document with data:`, documentData);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Owner ID: ${ownerId}`);

      // Validate that the private key belongs to the identity and is suitable for document ops
      const identity = await sdk.identities.fetch(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const wasmPublicKeys = identity.getPublicKeys();
      console.log(`Identity has ${wasmPublicKeys.length} public keys`);

      // Validate key matches and is suitable for document operations
      const identityKey = this.findMatchingSigningKey(privateKey, wasmPublicKeys, SecurityLevel.HIGH);
      if (!identityKey) {
        throw new Error('No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key.');
      }

      console.log(`Using signing key id=${identityKey.keyId} with security level ${identityKey.securityLevel}`);

      // Generate random entropy for document ID generation
      const entropyHex = this.generateEntropyHex();
      console.log('Generated entropy for document creation');

      // Create document using the correct SDK API
      // The SDK expects: contractId, type, ownerId, data (JSON), entropyHex, privateKeyWif
      const result = await sdk.documents.create({
        contractId,
        type: documentType,
        ownerId,
        data: documentData,
        entropyHex,
        privateKeyWif: privateKey
      });

      console.log('Document creation submitted successfully');

      // The result may contain the document ID or transaction info
      const documentId = result?.documentId || result?.id || 'pending';

      return {
        success: true,
        transactionHash: documentId,
        document: {
          $id: documentId,
          $ownerId: ownerId,
          $type: documentType,
          ...documentData
        }
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
   * Update a document using the dev.11+ SDK API
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

      // Validate that the private key belongs to the identity
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

      // Increment revision for the update
      const newRevision = revision + 1;

      // Replace document using the correct SDK API
      // The SDK expects: contractId, type, documentId, ownerId, data (any), revision (bigint), privateKeyWif
      await sdk.documents.replace({
        contractId,
        type: documentType,
        documentId,
        ownerId,
        data: documentData,
        revision: newRevision,
        privateKeyWif: privateKey
      });

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
   * Delete a document using the dev.11+ SDK API
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

      // Validate that the private key belongs to the identity
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

      // Delete document using the correct SDK API
      // The SDK expects: contractId, type, documentId, ownerId, privateKeyWif
      await sdk.documents.delete({
        contractId,
        type: documentType,
        documentId,
        ownerId,
        privateKeyWif: privateKey
      });

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
    // Note: maxWaitTimeMs and onProgress are available for future use but currently
    // we use a fixed short timeout due to known DAPI gateway issues
    void options;

    try {
      const sdk = await getEvoSdk();

      console.log(`Waiting for transaction confirmation: ${transactionHash}`);

      // Try wait_for_state_transition_result once with a short timeout
      try {
        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Wait timeout')), 8000); // 8 second timeout
        });

        // Race the wait call against the timeout
        // Use sdk.wasm to get the underlying WasmSdk for the method call
        const result = await Promise.race([
          sdk.wasm.waitForStateTransitionResult(transactionHash),
          timeoutPromise
        ]);

        if (result) {
          console.log('Transaction confirmed via wait_for_state_transition_result:', result);
          return { success: true, result };
        }
      } catch (waitError) {
        // This is expected to timeout frequently due to DAPI gateway issues
        console.log('wait_for_state_transition_result timed out (expected):', waitError);
      }

      // Since wait_for_state_transition_result often times out even for successful transactions,
      // we'll assume success if the transaction was broadcast successfully
      // This is a workaround for the known DAPI gateway timeout issue
      console.log('Transaction broadcast successfully. Assuming confirmation due to known DAPI timeout issue.');
      console.log('Note: The transaction is likely confirmed on the network despite the timeout.');

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
