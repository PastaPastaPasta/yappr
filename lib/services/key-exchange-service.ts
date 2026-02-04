/**
 * Key Exchange Service
 *
 * Service for querying the Dash Platform key exchange contract.
 * This contract stores encrypted login key responses from wallets.
 *
 * Queries by (contractId, appEphemeralPubKeyHash) to find wallet responses
 * without needing to know the user's identity upfront. Identity is discovered
 * from the response document's $ownerId.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md
 */

import bs58 from 'bs58'
import { BaseDocumentService, type QueryOptions } from './document-service'
import { KEY_EXCHANGE_CONTRACT_ID, DOCUMENT_TYPES } from '../constants'
import {
  deriveSharedSecret,
  decryptLoginKey,
  clearKeyMaterial
} from '../crypto/key-exchange'

/**
 * Login key response document from the key exchange contract.
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
  /** Hash160 of app's ephemeral public key (20 bytes) */
  appEphemeralPubKeyHash: Uint8Array
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
  /** The identity ID discovered from the response document's $ownerId */
  identityId: string
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
      appEphemeralPubKeyHash: this.toUint8Array(doc.appEphemeralPubKeyHash),
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
   * Get a response by contract ID and appEphemeralPubKeyHash.
   *
   * Queries using the unique (contractId, appEphemeralPubKeyHash) index.
   *
   * @param contractIdBytes - The application's contract ID (32 bytes)
   * @param appEphemeralPubKeyHash - Hash160 of app's ephemeral public key (20 bytes)
   * @returns The response document or null if not found
   */
  async getResponse(
    contractIdBytes: Uint8Array,
    appEphemeralPubKeyHash: Uint8Array
  ): Promise<LoginKeyResponse | null> {
    // contractId is an identifier field (contentMediaType) -> use base58
    const contractIdBase58 = bs58.encode(contractIdBytes)
    // appEphemeralPubKeyHash is a regular byte array -> use base64
    const hashBase64 = Buffer.from(appEphemeralPubKeyHash).toString('base64')

    const options: QueryOptions = {
      where: [
        ['contractId', '==', contractIdBase58],
        ['appEphemeralPubKeyHash', '==', hashBase64]
      ],
      limit: 1
    }

    const result = await this.query(options)
    return result.documents[0] || null
  }

  /**
   * Poll for a response and attempt to decrypt it.
   *
   * Polls using the unique (contractId, appEphemeralPubKeyHash) index.
   * Identity is discovered from the response document's $ownerId field.
   *
   * @param contractIdBytes - The application's contract ID (32 bytes)
   * @param appEphemeralPubKeyHash - Hash160 of app's ephemeral public key (20 bytes)
   * @param appEphemeralPrivateKey - The application's ephemeral private key (32 bytes)
   * @param options - Polling options
   * @returns The decrypted login key, metadata, and discovered identity ID
   * @throws If timeout or cancelled
   */
  async pollForResponse(
    contractIdBytes: Uint8Array,
    appEphemeralPubKeyHash: Uint8Array,
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

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        throw new Error('Cancelled')
      }

      onPoll?.()

      try {
        const response = await this.getResponse(
          contractIdBytes,
          appEphemeralPubKeyHash
        )

        console.log('Key exchange: Poll result', {
          hasResponse: !!response,
          ownerId: response?.$ownerId
        })

        if (response) {
          console.log('Key exchange: Found response, attempting decryption', {
            walletEphemeralPubKeyLength: response.walletEphemeralPubKey?.length,
            encryptedPayloadLength: response.encryptedPayload?.length,
            keyIndex: response.keyIndex,
            ownerId: response.$ownerId
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
              keyIndex: response.keyIndex,
              identityId: response.$ownerId
            })

            clearKeyMaterial(sharedSecret)

            return {
              loginKey,
              keyIndex: response.keyIndex,
              walletEphemeralPubKey: response.walletEphemeralPubKey,
              identityId: response.$ownerId
            }
          } catch (decryptError) {
            console.log('Key exchange: Decryption failed, waiting for new response...', decryptError)
          }
        }
      } catch (queryError) {
        console.warn('Key exchange: Poll query error:', queryError)
      }

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
}

// Singleton instance
export const keyExchangeService = new KeyExchangeService()
