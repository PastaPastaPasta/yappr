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
import { bytesToBase64, requireBytes } from '@/lib/bytes'

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
      contractId: requireBytes(doc.contractId, 'contractId'),
      appEphemeralPubKeyHash: requireBytes(doc.appEphemeralPubKeyHash, 'appEphemeralPubKeyHash'),
      walletEphemeralPubKey: requireBytes(doc.walletEphemeralPubKey, 'walletEphemeralPubKey'),
      encryptedPayload: requireBytes(doc.encryptedPayload, 'encryptedPayload'),
      keyIndex: doc.keyIndex as number
    }
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
    const hashBase64 = bytesToBase64(appEphemeralPubKeyHash)

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

}

// Singleton instance
export const keyExchangeService = new KeyExchangeService()
