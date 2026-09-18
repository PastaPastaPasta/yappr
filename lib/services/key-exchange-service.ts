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
import { BaseDocumentService, queryRawDocuments, type QueryOptions } from './document-service'
import { KEY_EXCHANGE_CONTRACT_ID, DOCUMENT_TYPES, keyExchangeIsV3 } from '../constants'
import { bytesToBase64, requireBytes } from '@/lib/bytes'
import { logger } from '@/lib/logger'

/** `{ $createdAt }` when the raw document carries one, `{}` otherwise (v2 documents do not). */
function createdAtOf(doc: Record<string, unknown>): { $createdAt?: number } {
  const createdAt = doc.$createdAt
  return createdAt === undefined || createdAt === null ? {} : { $createdAt: Number(createdAt) }
}

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
  /**
   * Creation timestamp, present on the v3 (indexOnly) contract only.
   *
   * There is no `$id` to delete an indexOnly document by — a delete replays
   * the whole value tuple, `$createdAt` included — so this is what a
   * consume-and-delete of the spent handshake would need. Undefined on v2,
   * where the stored document is deleted by id.
   */
  $createdAt?: number
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
   *
   * On v3 the document is SYNTHESIZED from the index entry that matched, so it
   * only carries the properties that index names: `byContractAndEphemeralKey`
   * stops at `encryptedPayload`, leaving `keyIndex` and `$createdAt` to
   * {@link KeyExchangeService.getHandshakeMeta}. `$revision` does not exist at
   * all — an indexOnly document has no stored row to revise.
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
      keyIndex: doc.keyIndex as number,
      ...createdAtOf(doc)
    }
  }

  /**
   * v3 only: the second read, on `byHandshakeMeta`.
   *
   * `keyIndex` and `$createdAt` cannot ride along with the polling read.
   * Drive refuses a query that leaves more than two index properties unbound
   * ("query is too far from index"), and the two the polling read pins
   * (contractId, appEphemeralPubKeyHash) already spend that budget on
   * `walletEphemeralPubKey` and `encryptedPayload` — the two the ECDH needs.
   * `byHandshakeMeta` is [appEphemeralPubKeyHash, keyIndex, $createdAt], so
   * the hash ALONE selects it and the remaining two levels come back in the
   * synthesized document.
   *
   * Issued once, after a response has been found — never on the poll itself.
   *
   * Deliberately NOT routed through `this.query()`: that runs
   * {@link KeyExchangeService.transformDocument}, whose `requireBytes` would
   * throw on this synthesis — a `byHandshakeMeta` entry carries neither
   * `walletEphemeralPubKey` nor `encryptedPayload`.
   */
  private async getHandshakeMeta(hashBase64: string): Promise<Record<string, unknown> | null> {
    const raw = await queryRawDocuments({
      dataContractId: this.contractId,
      documentTypeName: this.documentType,
      where: [['appEphemeralPubKeyHash', '==', hashBase64]],
      limit: 1
    })
    return raw[0] ?? null
  }

  /**
   * Get a response by contract ID and appEphemeralPubKeyHash.
   *
   * The query shape is identical on both topologies — v2 serves it from the
   * unique `(contractId, appEphemeralPubKeyHash)` index, v3 from the indexOnly
   * `byContractAndEphemeralKey` — and this is the call the login screen polls,
   * so it stays a single round trip while no response exists.
   *
   * On v3 a found response is completed with one extra read; see
   * {@link KeyExchangeService.getHandshakeMeta}.
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
    const response = result.documents[0]
    if (!response) return null
    if (!keyExchangeIsV3()) return response

    // The handshake has already succeeded at this point: the payload is in
    // hand and only the informational keyIndex (and the $createdAt a future
    // delete would need) are missing. Never fail the login over them — the
    // caller's poll loop treats a rejection as "no response yet" and would
    // keep retrying a login that is actually complete.
    const meta = await this.getHandshakeMeta(hashBase64).catch((error) => {
      logger.warn('Key exchange: byHandshakeMeta read failed; continuing without keyIndex', error)
      return null
    })
    // The two reads are independent lookups, each with its own ordering, so a
    // handshake answered by more than one wallet (possible on v3 — see
    // docs/KEY_EXCHANGE_V3.md) could pair one wallet's payload with another's
    // metadata. The terminal of `byHandshakeMeta` is $ownerId, so checking
    // that they describe the same responder is free.
    if (!meta || meta.$ownerId !== response.$ownerId) return response
    return { ...response, keyIndex: meta.keyIndex as number, ...createdAtOf(meta) }
  }
}

// Singleton instance
export const keyExchangeService = new KeyExchangeService()
