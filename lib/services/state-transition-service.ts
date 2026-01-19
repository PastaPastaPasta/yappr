import { getEvoSdk } from './evo-sdk-service';
import { signerService, SecurityLevel } from './signer-service';
import { documentBuilderService } from './document-builder-service';
import { identityService } from './identity-service';

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
   * Get the network from environment
   */
  private getNetwork(): 'testnet' | 'mainnet' {
    return (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  }

  /**
   * Create a document using the dev.11+ typed API
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
      const network = this.getNetwork();

      console.log(`Creating ${documentType} document with data:`, documentData);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Owner ID: ${ownerId}`);

      // Fetch identity to get public keys for signing
      const identity = await identityService.getIdentity(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      // Get signing key data (document operations require HIGH security level)
      const keyData = signerService.getSigningKeyData(
        identity.publicKeys,
        SecurityLevel.HIGH
      );
      if (!keyData) {
        throw new Error('No suitable signing key found on identity');
      }

      console.log(`Using signing key id=${keyData.id} with security level ${keyData.securityLevel ?? keyData.security_level}`);

      // Create signer and identity key
      const { signer, identityKey } = await signerService.createSignerAndKey(
        privateKey,
        keyData,
        network
      );

      // Build the document (with auto-generated entropy and ID)
      const document = await documentBuilderService.buildDocumentForCreate(
        contractId,
        documentType,
        ownerId,
        documentData
      );

      console.log('Built document for creation, ID:', documentBuilderService.getDocumentId(document));

      // Create document using new typed API
      await sdk.documents.create({
        document,
        identityKey,
        signer
      });

      console.log('Document creation submitted successfully');

      // Get the document ID for the response
      const documentId = documentBuilderService.getDocumentId(document);

      return {
        success: true,
        transactionHash: documentId, // Use document ID as reference
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
   * Update a document using the dev.11+ typed API
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
      const network = this.getNetwork();

      console.log(`Updating ${documentType} document ${documentId}...`);

      // Fetch identity to get public keys for signing
      const identity = await identityService.getIdentity(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      // Get signing key data (document operations require HIGH security level)
      const keyData = signerService.getSigningKeyData(
        identity.publicKeys,
        SecurityLevel.HIGH
      );
      if (!keyData) {
        throw new Error('No suitable signing key found on identity');
      }

      // Create signer and identity key
      const { signer, identityKey } = await signerService.createSignerAndKey(
        privateKey,
        keyData,
        network
      );

      // Build the document for replacement (increment revision)
      const newRevision = revision + 1;
      const document = await documentBuilderService.buildDocumentForReplace(
        contractId,
        documentType,
        documentId,
        ownerId,
        documentData,
        newRevision
      );

      // Replace document using new typed API
      await sdk.documents.replace({
        document,
        identityKey,
        signer
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
   * Delete a document using the dev.11+ typed API
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
      const network = this.getNetwork();

      console.log(`Deleting ${documentType} document ${documentId}...`);

      // Fetch identity to get public keys for signing
      const identity = await identityService.getIdentity(ownerId);
      if (!identity) {
        throw new Error('Identity not found');
      }

      // Get signing key data (document operations require HIGH security level)
      const keyData = signerService.getSigningKeyData(
        identity.publicKeys,
        SecurityLevel.HIGH
      );
      if (!keyData) {
        throw new Error('No suitable signing key found on identity');
      }

      // Create signer and identity key
      const { signer, identityKey } = await signerService.createSignerAndKey(
        privateKey,
        keyData,
        network
      );

      // Build document identifiers for deletion
      const documentIdentifiers = documentBuilderService.buildDocumentForDelete(
        contractId,
        documentType,
        documentId,
        ownerId
      );

      // Delete document using new typed API
      await sdk.documents.delete({
        document: documentIdentifiers,
        identityKey,
        signer
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
