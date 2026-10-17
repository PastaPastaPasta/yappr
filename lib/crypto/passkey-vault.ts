import { bytesEqual, concatBytes } from '@/lib/bytes'
import { deriveKeyPair, openBase, sealBase, type HpkeKeyPair } from './hpke'
import { KeyPurpose as Purpose, KeyType, SecurityLevel as Level } from './identity-keys'

/**
 * The passkey vault's crypto, v1 (docs/PASSKEY_VAULT.md, "Crypto").
 *
 * Each `vaultEntry` holds one bundle of signing keys, sealed with RFC 9180
 * HPKE (lib/crypto/hpke.ts) to the X25519 key a passkey's PRF output derives.
 * Only that public key goes on chain, so any signed-in device can seal a new
 * bundle to every passkey without a passkey prompt, and only the passkey can
 * open it.
 *
 * Pure and free of the SDK: what may go in a bundle for whom (CRITICAL keys
 * only for moderators, App Connect keys only when bound) and the check of
 * every opened key against the identity on chain belong to the vault service.
 * HPKE has no sender authentication, so an opened bundle proves nothing until
 * that check passes.
 */

export const PASSKEY_VAULT_VERSION = 1
export const VAULT_DOCUMENT_TYPE = 'vaultEntry'

/** What a bundle restores. */
export const BundleFormat = {
  /** A key the user signs in with themselves, plus their messaging key. */
  RAW_KEY: 1,
  /** An App Connect key ring: the wallet-granted, contract-bound keys of one grant. */
  KEY_RING: 2,
} as const
export type BundleFormat = (typeof BundleFormat)[keyof typeof BundleFormat]


const SLOT_LENGTH = 39
/** Bundles pad to a fixed length per format, so the ciphertext says nothing about how many keys it holds. */
const LAYOUT: Record<BundleFormat, { length: number; maxKeys: number }> = {
  [BundleFormat.RAW_KEY]: { length: 80, maxKeys: 2 },
  [BundleFormat.KEY_RING]: { length: 160, maxKeys: 4 },
}

const MIN_CREDENTIAL_ID_LENGTH = 16
const MAX_CREDENTIAL_ID_LENGTH = 255

export interface VaultKey {
  purpose: number
  securityLevel: number
  keyType: number
  keyId: number
  /** 32-byte secp256k1 private key. */
  privateKey: Uint8Array
}

export interface VaultBundle {
  format: BundleFormat
  /** Slot 0 is the entry's sign-in key (`authKeyId`); the App Connect group key for a key ring. */
  keys: VaultKey[]
}

/** The fields of a `vaultEntry` the crypto binds. */
export interface SealedVaultEntry {
  version: number
  credentialId: Uint8Array
  recipientKey: Uint8Array
  authKeyId: number
  enc: Uint8Array
  sealed: Uint8Array
}

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultCryptoError'
  }
}

const encoder = new TextEncoder()

function need(condition: boolean, message: string): asserts condition {
  if (!condition) throw new VaultCryptoError(message)
}

const is32 = (bytes: Uint8Array) => bytes.length === 32
const isKeyId = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
}

/**
 * The PRF `first` input for this vault contract. One input per deployment (no
 * stored salt), so a discoverable sign-in evaluates the PRF in the same
 * ceremony that picks the passkey. The browser hashes it again with
 * "WebAuthn PRF" ‖ 0x00 before the authenticator sees it.
 */
export function prfInput(contractId: Uint8Array): Uint8Array {
  need(is32(contractId), 'the vault contract id must be 32 bytes')
  return concatBytes(encoder.encode('yappr/passkey-vault/v1/prf'), contractId)
}

/** The passkey's HPKE recipient key pair, from its 32-byte PRF output. */
export function recipientFromPrf(prfOutput: Uint8Array): HpkeKeyPair {
  need(is32(prfOutput), 'the PRF output must be 32 bytes')
  return deriveKeyPair(prfOutput)
}

/** HPKE `info`: binds the vault contract and the owner identity. */
export function hpkeInfo(contractId: Uint8Array, ownerId: Uint8Array): Uint8Array {
  need(is32(contractId) && is32(ownerId), 'the contract and owner ids must be 32 bytes')
  return concatBytes(encoder.encode('yappr/passkey-vault/v1'), new Uint8Array([0]), contractId, ownerId)
}

/** AEAD additional data: binds the document type, version, credential, recipient key and sign-in key id. */
export function entryAad(entry: Pick<SealedVaultEntry, 'version' | 'credentialId' | 'recipientKey' | 'authKeyId'>): Uint8Array {
  need(entry.version >= 1 && entry.version <= 255 && Number.isInteger(entry.version), 'the entry version is out of range')
  need(entry.credentialId.length >= MIN_CREDENTIAL_ID_LENGTH && entry.credentialId.length <= MAX_CREDENTIAL_ID_LENGTH, 'the credential id must be 16 to 255 bytes')
  need(is32(entry.recipientKey), 'the recipient key must be 32 bytes')
  need(isKeyId(entry.authKeyId), 'the sign-in key id is out of range')
  return concatBytes(
    encoder.encode(VAULT_DOCUMENT_TYPE),
    new Uint8Array([0, entry.version, entry.credentialId.length]),
    entry.credentialId,
    entry.recipientKey,
    u32be(entry.authKeyId),
  )
}

const isAuth = (key: Pick<VaultKey, 'purpose'>) => key.purpose === Purpose.AUTHENTICATION

/**
 * Whether a bundle of `format` may carry `key`. MASTER keys and TRANSFER keys
 * never; a sign-in key at CRITICAL or HIGH; a messaging key at MEDIUM. Only a
 * key ring carries DECRYPTION keys.
 */
function keyAllowed(format: BundleFormat, key: Pick<VaultKey, 'purpose' | 'securityLevel' | 'keyType'>): boolean {
  if (isAuth(key)) {
    return (key.securityLevel === Level.CRITICAL || key.securityLevel === Level.HIGH)
      && (key.keyType === KeyType.ECDSA_SECP256K1 || key.keyType === KeyType.ECDSA_HASH160)
  }
  const purposeAllowed = key.purpose === Purpose.ENCRYPTION || (format === BundleFormat.KEY_RING && key.purpose === Purpose.DECRYPTION)
  return purposeAllowed && key.securityLevel === Level.MEDIUM && key.keyType === KeyType.ECDSA_SECP256K1
}

/** The shape rules both encode and decode apply. */
function checkKeys(format: BundleFormat, keys: VaultKey[]): void {
  const layout = LAYOUT[format]
  need(layout !== undefined, 'unknown bundle format')
  need(keys.length >= 1 && keys.length <= layout.maxKeys, `a bundle of this format holds 1 to ${layout.maxKeys} keys`)
  need(isAuth(keys[0]), 'slot 0 must be the sign-in key')
  for (const key of keys) {
    need(keyAllowed(format, key), `a key of purpose ${key.purpose} at level ${key.securityLevel} may not be stored`)
    need(isKeyId(key.keyId), 'a key id is out of range')
    need(key.privateKey.length === 32, 'a private key must be 32 bytes')
  }
  need(new Set(keys.map((key) => key.keyId)).size === keys.length, 'a key appears twice')
  if (format === BundleFormat.RAW_KEY) {
    need(keys.filter(isAuth).length === 1, 'a raw-key bundle holds one sign-in key')
  }
}

export function encodeBundle(bundle: VaultBundle): Uint8Array {
  checkKeys(bundle.format, bundle.keys)
  const out = new Uint8Array(LAYOUT[bundle.format].length)
  out[0] = bundle.format
  out[1] = bundle.keys.length
  bundle.keys.forEach((key, index) => {
    const offset = 2 + index * SLOT_LENGTH
    out.set([key.purpose, key.securityLevel, key.keyType], offset)
    out.set(u32be(key.keyId), offset + 3)
    out.set(key.privateKey, offset + 7)
  })
  return out
}

/** Decodes and checks a bundle; slot 0 must be the entry's `authKeyId`. */
export function decodeBundle(bytes: Uint8Array, authKeyId: number): VaultBundle {
  const format = bytes[0] as BundleFormat
  const layout = LAYOUT[format]
  need(layout !== undefined && bytes.length === layout.length, 'unknown bundle format')
  const count = bytes[1]
  need(count >= 1 && count <= layout.maxKeys, 'the bundle\'s key count is out of range')
  const keys: VaultKey[] = []
  for (let index = 0; index < count; index += 1) {
    const offset = 2 + index * SLOT_LENGTH
    keys.push({
      purpose: bytes[offset],
      securityLevel: bytes[offset + 1],
      keyType: bytes[offset + 2],
      keyId: readU32be(bytes, offset + 3),
      privateKey: bytes.slice(offset + 7, offset + SLOT_LENGTH),
    })
  }
  try {
    checkKeys(format, keys)
    need(bytes.subarray(2 + count * SLOT_LENGTH).every((byte) => byte === 0), 'the bundle\'s padding is not zero')
    need(keys[0].keyId === authKeyId, 'slot 0 is not the entry\'s sign-in key')
  } catch (error) {
    wipeBundle({ format, keys })
    throw error
  }
  return { format, keys }
}

/** Overwrites every private key in the bundle. */
export function wipeBundle(bundle: VaultBundle): void {
  for (const key of bundle.keys) key.privateKey.fill(0)
}

interface SealEntryInput {
  contractId: Uint8Array
  ownerId: Uint8Array
  credentialId: Uint8Array
  recipientKey: Uint8Array
  bundle: VaultBundle
  /** Test vectors only: fixes the HPKE ephemeral key. */
  ephemeralIkm?: Uint8Array
}

/**
 * Seals `bundle` to a passkey's recipient key. No passkey ceremony is needed,
 * so any signed-in device can seal (and re-seal) every passkey's entry.
 */
export function sealEntry(input: SealEntryInput): SealedVaultEntry {
  const authKeyId = input.bundle.keys[0]?.keyId ?? -1
  const fields = { version: PASSKEY_VAULT_VERSION, credentialId: input.credentialId, recipientKey: input.recipientKey, authKeyId }
  const aad = entryAad(fields)
  const plaintext = encodeBundle(input.bundle)
  try {
    const { enc, ciphertext } = sealBase(input.recipientKey, hpkeInfo(input.contractId, input.ownerId), aad, plaintext, input.ephemeralIkm)
    return { ...fields, enc, sealed: ciphertext }
  } finally {
    plaintext.fill(0)
  }
}

interface OpenEntryInput {
  contractId: Uint8Array
  ownerId: Uint8Array
  entry: SealedVaultEntry
  prfOutput: Uint8Array
}

/**
 * Opens an entry with its passkey's PRF output. Refuses a passkey that is not
 * this entry's before any decryption, and any entry whose tag, version or
 * bundle does not check. Wipes the derived secret key.
 */
export function openEntry(input: OpenEntryInput): VaultBundle {
  const { entry } = input
  need(entry.version === PASSKEY_VAULT_VERSION, 'unknown entry version')
  need(is32(entry.enc), 'the entry\'s encapsulated key must be 32 bytes')
  const recipient = recipientFromPrf(input.prfOutput)
  try {
    need(bytesEqual(recipient.publicKey, entry.recipientKey), 'this passkey does not open this entry')
    let plaintext: Uint8Array
    try {
      plaintext = openBase(entry.enc, recipient.privateKey, hpkeInfo(input.contractId, input.ownerId), entryAad(entry), entry.sealed)
    } catch (error) {
      if (error instanceof VaultCryptoError) throw error
      throw new VaultCryptoError('the entry does not decrypt')
    }
    try {
      return decodeBundle(plaintext, entry.authKeyId)
    } finally {
      plaintext.fill(0)
    }
  } finally {
    recipient.privateKey.fill(0)
  }
}
