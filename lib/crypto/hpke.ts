import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@/lib/bytes'

/**
 * RFC 9180 HPKE for exactly one suite, base mode, single shot (one message
 * per encapsulation, sequence number 0):
 *
 *   KEM  0x0020 DHKEM(X25519, HKDF-SHA256)
 *   KDF  0x0001 HKDF-SHA256
 *   AEAD 0x0003 ChaCha20-Poly1305
 *
 * This is the suite of RFC 9180 Appendix A.2, whose vectors the spec checks.
 * Nothing here is configurable on purpose: the passkey vault
 * (lib/crypto/passkey-vault.ts) is its only user.
 */

const KEM_ID = 0x0020
const KDF_ID = 0x0001
const AEAD_ID = 0x0003
/** Nsecret, Nk, Nn and Nsk for this suite. */
const N_SECRET = 32
const N_K = 32
const N_N = 12
const N_SK = 32

const encoder = new TextEncoder()
const EMPTY = new Uint8Array(0)

function i2osp(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width)
  let rest = value
  for (let index = width - 1; index >= 0; index -= 1) {
    out[index] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  return out
}

const HPKE_V1 = encoder.encode('HPKE-v1')
const SUITE_KEM = concatBytes(encoder.encode('KEM'), i2osp(KEM_ID, 2))
const SUITE_HPKE = concatBytes(encoder.encode('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2))

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concatBytes(HPKE_V1, suite, encoder.encode(label), ikm), salt)
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, concatBytes(i2osp(length, 2), HPKE_V1, suite, encoder.encode(label), info), length)
}

export interface HpkeKeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

/** RFC 9180 §7.1.3 DeriveKeyPair for X25519: sk = LabeledExpand(LabeledExtract("", "dkp_prk", ikm), "sk", "", 32). */
export function deriveKeyPair(ikm: Uint8Array): HpkeKeyPair {
  if (ikm.length < N_SK) throw new Error('HPKE: the key material must be at least 32 bytes')
  const dkpPrk = labeledExtract(SUITE_KEM, EMPTY, 'dkp_prk', ikm)
  try {
    const privateKey = labeledExpand(SUITE_KEM, dkpPrk, 'sk', EMPTY, N_SK)
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
  } finally {
    dkpPrk.fill(0)
  }
}

/** X25519, refusing the all-zero output a small-order point gives (RFC 9180 §7.1.4). */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(privateKey, publicKey)
  if (shared.every((byte) => byte === 0)) throw new Error('HPKE: the key exchange produced no secret')
  return shared
}

/** Wipes `dhOutput` once used: callers must not reuse it. */
function extractAndExpand(dhOutput: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(SUITE_KEM, EMPTY, 'eae_prk', dhOutput)
  try {
    return labeledExpand(SUITE_KEM, prk, 'shared_secret', kemContext, N_SECRET)
  } finally {
    prk.fill(0)
    dhOutput.fill(0)
  }
}

interface KeySchedule {
  key: Uint8Array
  baseNonce: Uint8Array
}

/** RFC 9180 §5.1 KeySchedule, base mode (no PSK). Wipes `sharedSecret` once used. */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): KeySchedule {
  const pskIdHash = labeledExtract(SUITE_HPKE, EMPTY, 'psk_id_hash', EMPTY)
  const infoHash = labeledExtract(SUITE_HPKE, EMPTY, 'info_hash', info)
  const context = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash)
  const secret = labeledExtract(SUITE_HPKE, sharedSecret, 'secret', EMPTY)
  try {
    return {
      key: labeledExpand(SUITE_HPKE, secret, 'key', context, N_K),
      baseNonce: labeledExpand(SUITE_HPKE, secret, 'base_nonce', context, N_N),
    }
  } finally {
    secret.fill(0)
    sharedSecret.fill(0)
  }
}

interface HpkeSealed {
  /** The encapsulated ephemeral public key (32 bytes). */
  enc: Uint8Array
  /** Ciphertext plus the 16-byte Poly1305 tag. */
  ciphertext: Uint8Array
}

/**
 * SealBase(pkR, info, aad, pt). `ephemeralIkm` is for test vectors only: it
 * fixes the ephemeral key through DeriveKeyPair. Production calls draw a fresh
 * random one per seal, so no two seals share a key or nonce.
 */
export function sealBase(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ephemeralIkm?: Uint8Array,
): HpkeSealed {
  const ikm = ephemeralIkm ?? globalThis.crypto.getRandomValues(new Uint8Array(N_SK))
  const ephemeral = deriveKeyPair(ikm)
  if (!ephemeralIkm) ikm.fill(0)
  try {
    const sharedSecret = extractAndExpand(dh(ephemeral.privateKey, recipientPublicKey), concatBytes(ephemeral.publicKey, recipientPublicKey))
    const { key, baseNonce } = keySchedule(sharedSecret, info)
    try {
      return { enc: ephemeral.publicKey, ciphertext: chacha20poly1305(key, baseNonce, aad).encrypt(plaintext) }
    } finally {
      key.fill(0)
    }
  } finally {
    ephemeral.privateKey.fill(0)
  }
}

/** OpenBase(enc, skR, info, aad, ct). Throws when the tag does not verify. */
export function openBase(
  enc: Uint8Array,
  recipientPrivateKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey)
  const sharedSecret = extractAndExpand(dh(recipientPrivateKey, enc), concatBytes(enc, recipientPublicKey))
  const { key, baseNonce } = keySchedule(sharedSecret, info)
  try {
    return chacha20poly1305(key, baseNonce, aad).decrypt(ciphertext)
  } finally {
    key.fill(0)
  }
}
