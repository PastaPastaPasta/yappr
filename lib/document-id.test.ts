/**
 * The id preimage layout is consensus: every client derives the id on its own
 * and Drive recomputes it. These tests pin the derivation to the vector rs-dpp
 * pins in `generate_document_id.rs` (`should_pin_the_nonce_derived_id`), so a
 * change here that still "works" locally is caught before it is refused on
 * chain with InvalidDocumentTransitionIdError.
 */
import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { bytesToHex } from './bytes'
import { deriveDocumentId, deriveDocumentIdBytes, nextIdentityContractNonce } from './document-id'

const CONTRACT = new Uint8Array(32).fill(1)
const OWNER = new Uint8Array(32).fill(2)
const ENTROPY = new Uint8Array(32).fill(7)
/** rs-dpp `PINNED_V1_ID`: contract [1;32], owner [2;32], type "note", entropy [7;32], nonce 1. */
const PINNED_V1_ID = 'e574ae73396611a517691d1f89275b6e99642cb9c176ce8cf879b1665c50f15f'

const vector = { contractId: CONTRACT, ownerId: OWNER, documentTypeName: 'note', entropy: ENTROPY, identityContractNonce: BigInt(1) }

describe('deriveDocumentIdBytes', () => {
  it("matches the platform's pinned v1 vector", () => {
    expect(bytesToHex(deriveDocumentIdBytes(vector))).toBe(PINNED_V1_ID)
  })

  it('accepts base58 identifiers and returns the same id', () => {
    const fromBase58 = deriveDocumentIdBytes({ ...vector, contractId: bs58.encode(CONTRACT), ownerId: bs58.encode(OWNER) })
    expect(bytesToHex(fromBase58)).toBe(PINNED_V1_ID)
    expect(deriveDocumentId(vector)).toBe(bs58.encode(deriveDocumentIdBytes(vector)))
  })

  it('derives a different id for every nonce and every entropy', () => {
    const base = bytesToHex(deriveDocumentIdBytes(vector))
    expect(bytesToHex(deriveDocumentIdBytes({ ...vector, identityContractNonce: BigInt(2) }))).not.toBe(base)
    expect(bytesToHex(deriveDocumentIdBytes({ ...vector, entropy: new Uint8Array(32).fill(8) }))).not.toBe(base)
  })

  it('is not the entropy-only v0 id', () => {
    // v0 = dsha256(contract || owner || type || entropy), the id wasm-dpp2 still generates.
    expect(bytesToHex(deriveDocumentIdBytes(vector))).not.toBe('c9d161a89213b995b948be856ebedd1e6fea44b476866318c52e1e50dddcdee8')
  })

  it('rejects malformed inputs rather than hashing them', () => {
    expect(() => deriveDocumentIdBytes({ ...vector, entropy: new Uint8Array(31) })).toThrow(/entropy/)
    expect(() => deriveDocumentIdBytes({ ...vector, ownerId: new Uint8Array(33) })).toThrow(/ownerId/)
    expect(() => deriveDocumentIdBytes({ ...vector, identityContractNonce: BigInt(-1) })).toThrow(/u64/)
    expect(() => deriveDocumentIdBytes({ ...vector, identityContractNonce: BigInt(1) << BigInt(64) })).toThrow(/u64/)
  })
})

describe('nextIdentityContractNonce', () => {
  it('starts at 1 for an identity that never wrote to the contract', () => {
    expect(nextIdentityContractNonce(undefined)).toBe(BigInt(1))
    expect(nextIdentityContractNonce(null)).toBe(BigInt(1))
  })

  it('increments the 40-bit sequence and drops the DIP-30 missing-revision bits', () => {
    expect(nextIdentityContractNonce(BigInt(41))).toBe(BigInt(42))
    const withBitset = (BigInt(0xabcdef) << BigInt(40)) | BigInt(41)
    expect(nextIdentityContractNonce(withBitset)).toBe(BigInt(42))
  })
})
