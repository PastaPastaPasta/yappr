/**
 * The id Platform gives the `transfer` document it writes for a token transfer.
 *
 * A tip document cites its transfer by id, so the write path has to know that
 * id. Platform derives it deterministically from things the sender chose before
 * broadcasting (rs-dpp `TokenEvent::build_historical_document_owned` →
 * `Document::generate_document_id_v0`):
 *
 *     sha256d( tokenId ‖ senderId ‖ "history_transfer" ‖ be64(identityContractNonce) )
 *
 * where the nonce is the identity-contract nonce carried by the token transfer
 * transition itself.
 *
 * The write path does NOT rely on this: it reads the transfer document back off
 * the sender's own history, which is also how it confirms the transfer landed at
 * all, and the local signing path never surfaces the nonce the SDK spent. This
 * is the independent check on that read-back — same input, same id, computed
 * without asking anyone — and it is what the verification battery asserts
 * against a live transfer.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'

/** The `document_type_name` Platform hashes for a transfer's history document. */
const HISTORY_TRANSFER_TYPE = 'history_transfer'

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** Big-endian u64, the encoding Platform hashes the nonce as. */
function beU64(value: bigint): Uint8Array {
  if (value < BigInt(0) || value > BigInt('0xffffffffffffffff')) {
    throw new Error(`identity-contract nonce out of u64 range: ${value}`)
  }
  const bytes = new Uint8Array(8)
  let remaining = value
  for (let index = 7; index >= 0; index--) {
    bytes[index] = Number(remaining & BigInt(0xff))
    remaining >>= BigInt(8)
  }
  return bytes
}

function decodeIdentifier(value: string, label: string): Uint8Array {
  const bytes = bs58.decode(value)
  if (bytes.length !== 32) throw new Error(`${label} is not a 32-byte identifier: ${value}`)
  return bytes
}

/**
 * The token-history `transfer` document id for one transfer.
 *
 * @param tokenId - Base58 id of the transferred token (YAPP)
 * @param senderId - Base58 identity id of the sender, who owns the transfer document
 * @param identityContractNonce - The nonce the transfer transition carried
 */
export function tokenHistoryTransferId(
  tokenId: string,
  senderId: string,
  identityContractNonce: bigint
): string {
  const token = decodeIdentifier(tokenId, 'tokenId')
  const sender = decodeIdentifier(senderId, 'senderId')
  const type = utf8(HISTORY_TRANSFER_TYPE)
  const nonce = beU64(identityContractNonce)

  const payload = new Uint8Array(token.length + sender.length + type.length + nonce.length)
  payload.set(token, 0)
  payload.set(sender, token.length)
  payload.set(type, token.length + sender.length)
  payload.set(nonce, token.length + sender.length + type.length)

  return bs58.encode(sha256(sha256(payload)))
}
