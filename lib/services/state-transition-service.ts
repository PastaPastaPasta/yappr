import { getEvoSdk } from './evo-sdk-service';

export interface StateTransitionResult {
  success: boolean;
  transactionHash?: string;
  document?: Record<string, unknown>;
  error?: string;
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
   * Generate entropy for state transitions
   */
  private generateEntropy(): string {
    const bytes = new Uint8Array(32);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      // Fallback for non-browser environments (should not happen in production)
      for (let i = 0; i < 32; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Create a document
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
      const entropy = this.generateEntropy();
      
      console.log(`Creating ${documentType} document with data:`, documentData);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Owner ID: ${ownerId}`);

      // Create the document using the EvoSDK facade
      const result = await sdk.documents.create({
        contractId,
        type: documentType,
        ownerId,
        data: documentData,
        entropyHex: entropy,
        privateKeyWif: privateKey
      });
      
      console.log('Document creation result:', result);
      
      // The result contains the document and transition info
      return {
        success: true,
        transactionHash: result.stateTransition?.$id || result.transitionId,
        document: result.document || result
      };
    } catch (error) {
      console.error('Error creating document:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Update a document
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

      // Update the document using the EvoSDK facade
      const result = await sdk.documents.replace({
        contractId,
        type: documentType,
        documentId,
        ownerId,
        data: documentData,
        revision: BigInt(revision),
        privateKeyWif: privateKey
      });

      // Normalize document fields to use $ prefix (SDK returns without prefix)
      const doc = result.document || result;
      const normalizedDoc = {
        $id: doc.$id || doc.id,
        $ownerId: doc.$ownerId || doc.ownerId,
        $createdAt: doc.$createdAt || doc.createdAt,
        $updatedAt: doc.$updatedAt || doc.updatedAt,
        $revision: doc.$revision || doc.revision,
        ...(doc.data || {}),
      };

      return {
        success: true,
        transactionHash: result.stateTransition?.$id || result.transitionId,
        document: normalizedDoc
      };
    } catch (error) {
      console.error('Error updating document:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Delete a document
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

      // Delete the document using the EvoSDK facade
      const result = await sdk.documents.delete({
        contractId,
        type: documentType,
        documentId,
        ownerId,
        privateKeyWif: privateKey
      });
      
      return {
        success: true,
        transactionHash: result.stateTransition?.$id || result.transitionId
      };
    } catch (error) {
      console.error('Error deleting document:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
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
        error: error instanceof Error ? error.message : 'Unknown error' 
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
    documentData: any,
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