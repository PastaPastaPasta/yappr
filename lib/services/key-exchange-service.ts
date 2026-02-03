/**
 * Key Exchange Service
 *
 * Service for querying the Dash Platform key exchange contract.
 * This contract stores encrypted login key responses from wallets.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md
 */

import { BaseDocumentService, type QueryOptions } from './document-service'
import { KEY_EXCHANGE_CONTRACT_ID, DOCUMENT_TYPES } from '../constants'
import {
  deriveSharedSecret,
  decryptLoginKey,
  clearKeyMaterial
} from '../crypto/key-exchange'

/**
 * Login key response document from the key exchange contract.
 *
 * Spec section 7.2 - Document Type: loginKeyResponse
 */
export interface LoginKeyResponse {
  /** Document ID */
  $id: string
  /** Owner identity ID */
  $ownerId: string
  /** Document revision */
  $revision: number
  /** Target application's contract ID (32 bytes) */
  contractId: Uint8Array
  /** Wallet's ephemeral public key for ECDH (33 bytes compressed) */
  walletEphemeralPubKey: Uint8Array
  /** AES-GCM encrypted payload: nonce (12) || ciphertext (32) || tag (16) = 60 bytes */
  encryptedPayload: Uint8Array
  /** The derivation index used for this login key */
  keyIndex: number
}

/**
 * Result of a successful key exchange decryption
 */
export interface DecryptedKeyExchangeResult {
  /** The decrypted 32-byte login key */
  loginKey: Uint8Array
  /** The key derivation index */
  keyIndex: number
  /** The wallet's ephemeral public key (for verification) */
  walletEphemeralPubKey: Uint8Array
}

/**
 * Options for polling for a key exchange response
 */
export interface PollOptions {
  /** Polling interval in milliseconds (default: 3000) */
  pollIntervalMs?: number
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number
  /** AbortSignal for cancellation */
  signal?: AbortSignal
  /** Callback for each poll attempt */
  onPoll?: () => void
}

/**
 * Service for querying the key exchange contract.
 *
 * Extends BaseDocumentService to query loginKeyResponse documents
 * and provides polling with automatic ECDH decryption.
 */
class KeyExchangeService extends BaseDocumentService<LoginKeyResponse> {
  constructor() {
    super(DOCUMENT_TYPES.LOGIN_KEY_RESPONSE, KEY_EXCHANGE_CONTRACT_ID)
  }

  /**
   * Transform raw document to LoginKeyResponse.
   */
  protected transformDocument(doc: Record<string, unknown>): LoginKeyResponse {
    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $revision: doc.$revision as number,
      contractId: this.toUint8Array(doc.contractId),
      walletEphemeralPubKey: this.toUint8Array(doc.walletEphemeralPubKey),
      encryptedPayload: this.toUint8Array(doc.encryptedPayload),
      keyIndex: doc.keyIndex as number
    }
  }

  /**
   * Convert various byte array formats to Uint8Array.
   */
  private toUint8Array(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) {
      return data
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data)
    }
    if (typeof data === 'string') {
      // Assume base64
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    }
    // Handle Buffer-like objects
    if (data && typeof data === 'object' && 'type' in data && 'data' in data) {
      const bufferLike = data as { type: string; data: number[] }
      if (bufferLike.type === 'Buffer' && Array.isArray(bufferLike.data)) {
        return new Uint8Array(bufferLike.data)
      }
    }
    throw new Error(`Cannot convert to Uint8Array: ${typeof data}`)
  }

  /**
   * Get the most recent response for an identity and contract.
   *
   * Spec section 7.4 - Query by ($ownerId, contractId):
   *   where: [
   *     ['$ownerId', '==', identityId],
   *     ['contractId', '==', applicationContractId]
   *   ]
   *
   * @param identityId - The user's identity ID (Base58)
   * @param contractIdBytes - The application's contract ID (32 bytes)
   * @returns The response document or null if not found
   */
  async getResponseForIdentity(
    identityId: string,
    contractIdBytes: Uint8Array
  ): Promise<LoginKeyResponse | null> {
    // Encode contractId as base64 for SDK query (byte array fields require base64)
    const contractIdBase64 = Buffer.from(contractIdBytes).toString('base64')

    const options: QueryOptions = {
      where: [
        ['$ownerId', '==', identityId],
        ['contractId', '==', contractIdBase64]
      ],
      limit: 1
    }

    const result = await this.query(options)
    return result.documents[0] || null
  }

  /**
   * Poll for a response and attempt to decrypt it.
   *
   * This method polls the contract for a response, and when one is found,
   * attempts ECDH decryption. If decryption fails (wrong ephemeral key),
   * it continues polling until the timeout.
   *
   * Spec section 9.3 - Response Matching:
   *   1. Query by $ownerId and contractId
   *   2. Compute ECDH shared secret using walletEphemeralPubKey
   *   3. Attempt AES-GCM decryption
   *   4. If decryption succeeds (tag validates): response is valid
   *   5. If decryption fails: response was for a different request, keep polling
   *
   * @param identityId - The user's identity ID (Base58)
   * @param contractIdBytes - The application's contract ID (32 bytes)
   * @param appEphemeralPrivateKey - The application's ephemeral private key (32 bytes)
   * @param options - Polling options
   * @returns The decrypted login key and metadata
   * @throws If timeout or cancelled
   */
  async pollForResponse(
    identityId: string,
    contractIdBytes: Uint8Array,
    appEphemeralPrivateKey: Uint8Array,
    options: PollOptions = {}
  ): Promise<DecryptedKeyExchangeResult> {
    const {
      pollIntervalMs = 3000,
      timeoutMs = 120000,
      signal,
      onPoll
    } = options

    const startTime = Date.now()
    let lastRevision: number | null = null

    while (Date.now() - startTime < timeoutMs) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new Error('Cancelled')
      }

      // Notify caller of poll attempt
      onPoll?.()

      try {
        const response = await this.getResponseForIdentity(identityId, contractIdBytes)

        // Check if this is a new or updated response by comparing $revision
        // The document $id is stable (unique index), but $revision increments on updates
        const isNewOrUpdated = response && response.$revision !== lastRevision

        console.log('Key exchange: Poll result', {
          hasResponse: !!response,
          revision: response?.$revision,
          lastRevision,
          isNewOrUpdated
        })

        if (isNewOrUpdated) {
          // New or updated response found - attempt decryption
          lastRevision = response.$revision

          console.log('Key exchange: Attempting decryption', {
            walletEphemeralPubKeyLength: response.walletEphemeralPubKey?.length,
            encryptedPayloadLength: response.encryptedPayload?.length,
            keyIndex: response.keyIndex
          })

          try {
            const sharedSecret = deriveSharedSecret(
              appEphemeralPrivateKey,
              response.walletEphemeralPubKey
            )

            const loginKey = await decryptLoginKey(
              response.encryptedPayload,
              sharedSecret
            )

            console.log('Key exchange: Decryption successful!', {
              loginKeyLength: loginKey?.length,
              keyIndex: response.keyIndex
            })

            // Clear shared secret immediately after use
            clearKeyMaterial(sharedSecret)

            // Success! Return the decrypted result
            return {
              loginKey,
              keyIndex: response.keyIndex,
              walletEphemeralPubKey: response.walletEphemeralPubKey
            }
          } catch (decryptError) {
            // Decryption failed - this response was for a different request
            // Continue polling for a new response
            console.log('Key exchange: Decryption failed, waiting for new response...', decryptError)
          }
        }
      } catch (queryError) {
        // Query error - log and continue polling
        console.warn('Key exchange: Poll query error:', queryError)
      }

      // Wait before next poll
      await this.sleep(pollIntervalMs, signal)
    }

    throw new Error('Timeout waiting for key exchange response')
  }

  /**
   * Sleep helper that respects AbortSignal.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms)

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeout)
          reject(new Error('Cancelled'))
          return
        }

        const onAbort = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
          reject(new Error('Cancelled'))
        }

        signal.addEventListener('abort', onAbort)
      }
    })
  }

  /**
   * Get the current key index for an identity/contract combination.
   * Returns 0 if no existing response is found.
   *
   * Used to determine the key index for a new login request:
   * - No existing response: use 0
   * - Existing response, normal login: use existing keyIndex
   * - Rotation requested: use existing keyIndex + 1
   *
   * @param identityId - The user's identity ID (Base58)
   * @param contractIdBytes - The application's contract ID (32 bytes)
   * @returns The current key index (0 if no response exists)
   */
  async getCurrentKeyIndex(
    identityId: string,
    contractIdBytes: Uint8Array
  ): Promise<number> {
    const response = await this.getResponseForIdentity(identityId, contractIdBytes)
    return response?.keyIndex ?? 0
  }
}

// Singleton instance
export const keyExchangeService = new KeyExchangeService()
