/**
 * The hand-built create must decode EXACTLY. From protocol 14 at 4.2.0-beta.5
 * (platform#5011) a node decodes a raw state transition with
 * `deserialize_from_bytes_untrusted_exact_in_version` and refuses any bytes
 * left over after it (`SerializedObjectParsingError`, 10002, unpaid).
 *
 * The wasm exposes only the loose decoder (`StateTransition.fromBytes` is
 * rs-dpp's `deserialize_from_bytes_untrusted`, which ignores a suffix). So
 * exactness is pinned by a round trip: the bytes decode, re-encode to the SAME
 * bytes, and nothing is left over. Bincode's encoding is deterministic, so a
 * decode that stopped short would re-encode to fewer bytes. The loose-decoder
 * case below shows why the round trip, not a successful decode, is the check.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  BatchTransition,
  Document,
  DocumentActionFeeAgreement,
  DocumentCreateTransition,
  IdentityPublicKey,
  PlatformVersion,
  PrivateKey,
  StateTransition,
  TokenPaymentInfo,
  ensureInitialized,
} from '@dashevo/evo-sdk'
import type { DocumentObject } from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import { bytesToHex } from './bytes'
import { buildSignedCreateTransition } from './manual-batch'
import { actionFeeAgreementOptions } from './transition-agreements'

const CONTRACT = new Uint8Array(32).fill(1)
const OWNER = new Uint8Array(32).fill(2)
const ENTROPY = new Uint8Array(32).fill(7)
const NONCE = BigInt(1)
/** A fixed secp256k1 test key: the signature is deterministic (RFC 6979). */
const PRIVATE_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'

beforeAll(async () => {
  await ensureInitialized()
})

function post(): Document {
  return Document.fromObject(
    {
      $formatVersion: '0',
      $id: new Uint8Array(32).fill(9),
      $ownerId: OWNER,
      $dataContractId: CONTRACT,
      $type: 'post',
      $revision: BigInt(1),
      $entropy: ENTROPY,
      content: 'beta.5 exact decode',
      language: 'en',
      quotedPostId: new Uint8Array(32).fill(3),
    } as unknown as DocumentObject,
    PlatformVersion.current()
  )
}

/** A v9 post create as `createDocument` builds it: YAPP payment with the gas offer and the moderators fee. */
function signedPost(): StateTransition {
  const privateKey = PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet')
  const identityKey = new IdentityPublicKey({
    keyId: 1,
    purpose: 'authentication',
    securityLevel: 'high',
    keyType: 'ecdsa_secp256k1',
    data: privateKey.getPublicKey().toBytes(),
  })
  return buildSignedCreateTransition({
    document: post(),
    ownerId: bs58.encode(OWNER),
    identityContractNonce: NONCE,
    tokenPaymentInfo: new TokenPaymentInfo({ tokenContractPosition: 0, maximumTokenCost: BigInt(10), gasFeesPaidBy: 2 }),
    actionFeeAgreement: new DocumentActionFeeAgreement(
      actionFeeAgreementOptions({ owner: BigInt(0), moderators: BigInt(80_000_000), pricing: 'feeMultiplier' }, BigInt(1000))
    ),
    privateKey,
    identityKey,
  })
}

describe('buildSignedCreateTransition (hand-built v9 create)', () => {
  it('serializes to bytes that decode and re-encode byte for byte, with nothing left over', () => {
    const bytes = signedPost().toBytes()
    const decoded = StateTransition.fromBytes(bytes)
    const reencoded = decoded.toBytes()
    expect(reencoded.length).toBe(bytes.length)
    expect(bytesToHex(reencoded)).toBe(bytesToHex(bytes))
    // The batch inside decodes to exactly one create, signed, carrying the agreement.
    expect(decoded.signature?.length).toBe(65)
    const batch = BatchTransition.fromStateTransition(decoded)
    expect(batch.transitions).toHaveLength(1)
  })

  it('carries the action fee agreement and the token payment through the round trip', () => {
    const json = JSON.stringify(BatchTransition.fromStateTransition(StateTransition.fromBytes(signedPost().toBytes())).toJSON())
    expect(json).toContain('80000000')
    expect(json).toMatch(/gasFeesPaidBy/i)
  })

  it('is deterministic: the same inputs sign the same bytes', () => {
    expect(bytesToHex(signedPost().toBytes())).toBe(bytesToHex(signedPost().toBytes()))
  })

  it('writes the derived id back onto the document', () => {
    const document = post()
    const placeholder = document.id.toBase58()
    const signed = buildSignedCreateTransition({
      document,
      ownerId: bs58.encode(OWNER),
      identityContractNonce: NONCE,
      privateKey: PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet'),
      identityKey: new IdentityPublicKey({
        keyId: 1,
        purpose: 'authentication',
        securityLevel: 'high',
        keyType: 'ecdsa_secp256k1',
        data: PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet').getPublicKey().toBytes(),
      }),
    })
    const [batched] = BatchTransition.fromStateTransition(signed).transitions
    const create = DocumentCreateTransition.fromDocumentTransition(batched.toTransition() as never)
    expect(create.base.id.toBase58()).toBe(document.id.toBase58())
    // The placeholder `$id` ([9;32]) was replaced, not merely echoed.
    expect(document.id.toBase58()).not.toBe(placeholder)
    expect(placeholder).toBe(bs58.encode(new Uint8Array(32).fill(9)))
  })

  it('shows why the round trip is the check: the wasm decoder ignores a suffix a beta.5 node refuses', () => {
    const bytes = signedPost().toBytes()
    const padded = new Uint8Array(bytes.length + 1)
    padded.set(bytes)
    padded[bytes.length] = 0xab
    // Loose: decodes as the transition alone...
    const decoded = StateTransition.fromBytes(padded)
    // ...and re-encodes shorter than its input, which is what #5011 refuses.
    expect(decoded.toBytes().length).toBe(bytes.length)
    expect(decoded.toBytes().length).toBeLessThan(padded.length)
  })
})
