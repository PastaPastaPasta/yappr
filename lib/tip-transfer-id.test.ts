import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha2.js'
import { tokenHistoryTransferId } from './tip-transfer-id'

const TOKEN_ID = 'BQP2VQvGSKGZJbtJnSVfXfHytHJVgRKkm7VbP2Nk2Nkh'
const SENDER = '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M'

/**
 * The derivation restated from the Rust, independently of the implementation:
 * `Document::generate_document_id_v0(token_id, owner_id, "history_transfer",
 * be64(nonce))` over `sha256d`. If the two ever disagree, the id a tip cites
 * would not be the id Platform wrote, and every tip would be a paid 40120.
 */
function expectedId(tokenId: string, senderId: string, nonce: bigint): string {
  const nonceBytes = new Uint8Array(8)
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, false)
  const payload = new Uint8Array([
    ...bs58.decode(tokenId),
    ...bs58.decode(senderId),
    ...new TextEncoder().encode('history_transfer'),
    ...nonceBytes,
  ])
  return bs58.encode(sha256(sha256(payload)))
}

describe('the token-history transfer id', () => {
  it('matches the platform derivation', () => {
    for (const nonce of [BigInt(1), BigInt(2), BigInt(255), BigInt(4096), BigInt('1099511627776')]) {
      expect(tokenHistoryTransferId(TOKEN_ID, SENDER, nonce)).toBe(expectedId(TOKEN_ID, SENDER, nonce))
    }
  })

  it('is a 32-byte identifier', () => {
    expect(bs58.decode(tokenHistoryTransferId(TOKEN_ID, SENDER, BigInt(7)))).toHaveLength(32)
  })

  it('separates transfers by nonce, sender and token', () => {
    const base = tokenHistoryTransferId(TOKEN_ID, SENDER, BigInt(7))
    expect(tokenHistoryTransferId(TOKEN_ID, SENDER, BigInt(8))).not.toBe(base)
    expect(tokenHistoryTransferId(TOKEN_ID, TOKEN_ID, BigInt(7))).not.toBe(base)
    expect(tokenHistoryTransferId(SENDER, SENDER, BigInt(7))).not.toBe(base)
  })

  it('refuses inputs it could only hash into a wrong id', () => {
    expect(() => tokenHistoryTransferId('not-base58!', SENDER, BigInt(1))).toThrow()
    expect(() => tokenHistoryTransferId(TOKEN_ID, 'abc', BigInt(1))).toThrow(/32-byte identifier/)
    expect(() => tokenHistoryTransferId(TOKEN_ID, SENDER, BigInt(-1))).toThrow(/u64 range/)
  })
})
