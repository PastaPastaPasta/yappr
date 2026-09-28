/**
 * The id preimage layout is consensus. Yappr used to carry its own copy of the
 * v1 derivation (4.2.0-beta.3); from beta.4 it asks wasm-dpp2. These tests pin
 * the wasm derivation to the vector rs-dpp pins in `generate_document_id.rs`
 * (`should_pin_the_nonce_derived_id`) — the same vector the removed JS copy was
 * pinned to — so dropping the JS copy is proved equivalent, and a regression to
 * the entropy-only v0 id is caught.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { Document, DocumentCreateTransition, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk'
import type { DocumentObject } from '@dashevo/evo-sdk'
import { bytesToHex } from './bytes'
import { allocateIdentityContractNonce, documentIdForCreate, identityContractNonceConsumed, nextIdentityContractNonce } from './document-id'

const CONTRACT = new Uint8Array(32).fill(1)
const OWNER = new Uint8Array(32).fill(2)
const ENTROPY = new Uint8Array(32).fill(7)
/** rs-dpp `PINNED_V1_ID`: contract [1;32], owner [2;32], type "note", entropy [7;32], nonce 1. */
const PINNED_V1_ID = 'e574ae73396611a517691d1f89275b6e99642cb9c176ce8cf879b1665c50f15f'
/** The entropy-only v0 id for the same inputs, which protocol 14 refuses. */
const V0_ID = 'c9d161a89213b995b948be856ebedd1e6fea44b476866318c52e1e50dddcdee8'

const vector = { contractId: CONTRACT, ownerId: OWNER, documentTypeName: 'note', entropy: ENTROPY, identityContractNonce: BigInt(1) }
const hexOf = (base58: string) => bytesToHex(bs58.decode(base58))

beforeAll(async () => {
  await ensureInitialized()
})

describe('documentIdForCreate (wasm Document.generateId)', () => {
  it("matches the platform's pinned v1 vector the removed JS derivation was pinned to", () => {
    expect(hexOf(documentIdForCreate(vector))).toBe(PINNED_V1_ID)
  })

  it('accepts base58 identifiers and returns the same id', () => {
    const fromBase58 = documentIdForCreate({ ...vector, contractId: bs58.encode(CONTRACT), ownerId: bs58.encode(OWNER) })
    expect(hexOf(fromBase58)).toBe(PINNED_V1_ID)
  })

  it('derives a different id for every nonce and every entropy, never the v0 id', () => {
    const base = documentIdForCreate(vector)
    expect(documentIdForCreate({ ...vector, identityContractNonce: BigInt(2) })).not.toBe(base)
    expect(documentIdForCreate({ ...vector, entropy: new Uint8Array(32).fill(8) })).not.toBe(base)
    expect(hexOf(base)).not.toBe(V0_ID)
  })

  it('rejects malformed entropy rather than hashing it', () => {
    expect(() => documentIdForCreate({ ...vector, entropy: new Uint8Array(31) })).toThrow()
  })

  it('agrees with the id DocumentCreateTransition writes back onto the document', () => {
    // The hand-built create path relies on this: the transition overwrites the
    // document's placeholder id with the derived one, the same id the auth
    // vault encrypts against up front.
    const document = Document.fromObject(
      {
        $formatVersion: '0',
        $id: new Uint8Array(32).fill(9),
        $ownerId: OWNER,
        $dataContractId: CONTRACT,
        $type: 'note',
        $revision: BigInt(1),
        $entropy: ENTROPY,
      } as unknown as DocumentObject,
      PlatformVersion.current()
    )
    const transition = new DocumentCreateTransition({ document, identityContractNonce: BigInt(1) })
    expect(hexOf(document.id.toBase58())).toBe(PINNED_V1_ID)
    expect(transition.base.id.toBase58()).toBe(document.id.toBase58())
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

describe('allocateIdentityContractNonce', () => {
  it("is Platform's next nonce when nothing is reserved or the reservation has executed", () => {
    expect(allocateIdentityContractNonce(BigInt(132), null)).toBe(BigInt(133))
    expect(allocateIdentityContractNonce(undefined, null)).toBe(BigInt(1))
    expect(allocateIdentityContractNonce(BigInt(140), BigInt(136))).toBe(BigInt(141))
  })

  it('skips a nonce broadcast but not yet executed (QA D-01: both writes took 133, then both took 136)', () => {
    expect(allocateIdentityContractNonce(BigInt(132), BigInt(133))).toBe(BigInt(134))
    expect(allocateIdentityContractNonce(BigInt(135), BigInt(136))).toBe(BigInt(137))
  })

  it('reads the sequence past the missing-revision bits', () => {
    const withBitset = (BigInt(1) << BigInt(40)) | BigInt(135)
    expect(allocateIdentityContractNonce(withBitset, BigInt(136))).toBe(BigInt(137))
  })

  it('ignores a reservation Drive would refuse as too far in the future', () => {
    expect(allocateIdentityContractNonce(BigInt(100), BigInt(123))).toBe(BigInt(124))
    expect(allocateIdentityContractNonce(BigInt(100), BigInt(124))).toBe(BigInt(101))
  })
})

describe('identityContractNonceConsumed', () => {
  const missing = (...behind: number[]) => behind.reduce((bits, b) => bits | (BigInt(1) << BigInt(40 + b - 1)), BigInt(0))

  it('is false for a nonce ahead of the tip, or when the identity never wrote', () => {
    expect(identityContractNonceConsumed(BigInt(132), BigInt(133))).toBe(false)
    expect(identityContractNonceConsumed(undefined, BigInt(1))).toBe(false)
  })

  it('is true for the tip itself: the two-tab race of QA D-01, both tabs signing 133', () => {
    expect(identityContractNonceConsumed(BigInt(133), BigInt(133))).toBe(true)
  })

  it('is true behind the tip unless that nonce is still flagged missing', () => {
    expect(identityContractNonceConsumed(BigInt(137), BigInt(136))).toBe(true)
    expect(identityContractNonceConsumed(missing(1) | BigInt(137), BigInt(136))).toBe(false)
    expect(identityContractNonceConsumed(missing(1) | BigInt(137), BigInt(135))).toBe(true)
    expect(identityContractNonceConsumed(missing(3) | BigInt(137), BigInt(134))).toBe(false)
  })

  it('is true once the nonce has fallen out of the window behind the tip', () => {
    expect(identityContractNonceConsumed(missing(24) | BigInt(124), BigInt(100))).toBe(false)
    expect(identityContractNonceConsumed(BigInt(125), BigInt(100))).toBe(true)
  })
})
