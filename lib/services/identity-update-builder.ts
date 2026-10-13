/**
 * Identity Update Builder Service
 *
 * Builds unsigned IdentityUpdateTransition state transitions for wallet signing.
 * This service creates the transition bytes that get encoded into a dash-st: URI
 * for the wallet to sign and broadcast.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md Section 11.5
 */

import type { YapprRegisteredKey } from 'platform-auth'
import { logger } from '@/lib/logger'
import { getEvoSdk } from './evo-sdk-service'
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed'
import * as secp256k1 from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hash160 } from '../crypto/hash'
import { getPublicKey } from '../crypto/keys'
import { bytesEqual, requireBytes } from '@/lib/bytes'
import { KeyPurpose, KeyType, resolveKeyPurpose } from '@/lib/crypto/identity-keys'
import { isBoundToContract } from '@/lib/crypto/encryption-key-lookup'
import { deriveEncryptionKey } from '@/lib/crypto/derive-encryption-key'
import { messagingAnchorId } from '@/lib/app-connect/config'

let wasmInitialized = false
async function ensureWasmInitialized() {
  if (!wasmInitialized) {
    await initWasm()
    wasmInitialized = true
  }
  return wasmSdk
}

/**
 * Key registration request containing the keys to add
 */
export interface KeyRegistrationRequest {
  /** Identity ID (Base58) */
  identityId: string
  /** Auth key private key bytes (32 bytes) */
  authPrivateKey: Uint8Array
  /** Auth key public key bytes (33 bytes compressed) */
  authPublicKey: Uint8Array
  /** Encryption key private key bytes (32 bytes) */
  encryptionPrivateKey: Uint8Array
  /** Encryption key public key bytes (33 bytes compressed) */
  encryptionPublicKey: Uint8Array
}

/**
 * Result of building an unsigned identity update transition
 */
export interface UnsignedTransitionResult {
  /** Serialized transition bytes (for dash-st: URI) */
  transitionBytes: Uint8Array
  /** The keys it adds, in key id order */
  keys: YapprRegisteredKey[]
  /** The identity's revision after the update */
  identityRevision: bigint
}

// Dash/Bitcoin compact signature header constants
const COMPACT_SIG_BASE = 27
const COMPACT_SIG_COMPRESSED_FLAG = 4

/** An identity key as the SDK's fetched identity holds it (a wasm IdentityPublicKey). */
type RegisteredIdentityKey = {
  keyId: number
  purpose?: string | number
  purposeNumber?: number
  keyType?: string | number
  keyTypeNumber?: number
  type?: number
  data?: string
  disabledAt?: unknown
  contractBounds?: unknown
  toJSON: () => { data: string | Uint8Array }
}

function keyEnumMatches(value: unknown, numberValue: unknown, expectedNumber: number, expectedName: string): boolean {
  if (numberValue === expectedNumber || value === expectedNumber) return true
  return typeof value === 'string' && value.toLowerCase() === expectedName
}

function keyMatchesPurposeAndType(
  key: RegisteredIdentityKey,
  expectedPurposeNumber: number,
  expectedPurposeName: string,
  expectedTypeNumber: number,
  expectedTypeName: string
): boolean {
  return (
    keyEnumMatches(key.purpose, key.purposeNumber, expectedPurposeNumber, expectedPurposeName) &&
    keyEnumMatches(key.keyType ?? key.type, key.keyTypeNumber ?? key.type, expectedTypeNumber, expectedTypeName)
  )
}

/** Whether `publicKeys` hold `data` (a public key, or its hash160) as a key of this purpose and type. */
function hasKey(
  publicKeys: RegisteredIdentityKey[],
  purpose: [number, string],
  type: [number, string],
  data: Uint8Array,
): boolean {
  return publicKeys.some((key) => keyMatchesPurposeAndType(key, purpose[0], purpose[1], type[0], type[1])
    // The WASM `.data` getter returns a hex string; `.toJSON().data` may differ.
    && bytesEqual(requireBytes(key.data ?? key.toJSON().data, 'identity key data'), data))
}

/** Whether the identity has the auth key a sign-in registers (its hash160, as an ECDSA_HASH160 key). */
function hasAuthKey(publicKeys: RegisteredIdentityKey[], authPublicKey: Uint8Array): boolean {
  return hasKey(publicKeys, [KeyPurpose.AUTHENTICATION, 'authentication'], [KeyType.ECDSA_HASH160, 'ecdsa_hash160'], hash160(authPublicKey))
}

/**
 * Whether the identity has an enabled ENCRYPTION key (of any type) bound to
 * `contractId`. The newest such key is the contract's current one, so adding
 * another would replace it and orphan everything peers encrypted to it.
 */
function hasBoundEncryptionKey(publicKeys: RegisteredIdentityKey[], contractId: string): boolean {
  return publicKeys.some((key) => resolveKeyPurpose(key.purposeNumber ?? key.purpose) === KeyPurpose.ENCRYPTION
    && !key.disabledAt
    && isBoundToContract(key.contractBounds, contractId))
}

/**
 * Double SHA256 hash (SHA256d) - used by Dash for signing
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/**
 * Sign data with a private key using secp256k1 (recoverable signature format).
 * Returns a 65-byte signature: header (1) + r (32) + s (32)
 *
 * Dash signing process:
 * 1. Double SHA256 hash the data
 * 2. Sign the hash with ECDSA (recoverable)
 */
async function signWithKey(privateKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Step 1: Double SHA256 hash the data (Dash standard)
  const dataHash = doubleSha256(data)

  // Step 2: Sign the hash (prehash: false since we already hashed)
  // noble/secp256k1 'recovered' format: recovery (1) + r (32) + s (32)
  const signature = await secp256k1.signAsync(dataHash, privateKey, {
    format: 'recovered',
    prehash: false  // Don't hash again - we already did double SHA256
  })

  // Encode as "compact" header for recoverable signatures.
  // This matches Dash/Bitcoin compact signature format.
  const recoveryId = signature[0]
  const result = new Uint8Array(65)
  result[0] = recoveryId + COMPACT_SIG_BASE + COMPACT_SIG_COMPRESSED_FLAG
  result.set(signature.slice(1), 1)
  return result
}
/** One key an unsigned IdentityUpdate adds. */
interface KeyToAdd {
  purpose: 'authentication' | 'encryption'
  securityLevel: 'high' | 'medium'
  keyType: 'ecdsa_hash160' | 'ecdsa_secp256k1'
  /** The key data on chain: the 33-byte public key, or its hash160. */
  data: Uint8Array
  /**
   * Signs the ownership proof. Omitted for ECDSA_HASH160 keys: their proof
   * would reveal the full public key.
   */
  proofPrivateKey?: Uint8Array
  /** Binds the key to this contract (`singleContract`). */
  boundToContract?: string
}

/** The identity already has an enabled encryption key bound to the contract: adding another would replace it. */
export class BoundKeyExistsError extends Error {
  constructor() {
    super('The identity already has an encryption key bound to this contract')
  }
}

/**
 * Build an unsigned IdentityUpdateTransition adding the keys `select` picks
 * from the identity's current keys (ids assigned in order after the
 * identity's highest); `select` may throw instead. Each key with a
 * `proofPrivateKey` signs the transition's signable bytes to prove
 * ownership; the transition itself is NOT signed: the wallet signs it with a
 * MASTER key.
 */
async function buildUnsignedAddKeysTransition(
  identityId: string,
  select: (publicKeys: RegisteredIdentityKey[]) => KeyToAdd[],
): Promise<UnsignedTransitionResult> {
  const sdk = await getEvoSdk()
  const wasm = await ensureWasmInitialized()

  logger.debug('IdentityUpdateBuilder: Fetching identity', identityId)
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) {
    throw new Error(`Identity not found: ${identityId}`)
  }
  const keys = select(identity.publicKeys as unknown as RegisteredIdentityKey[])
  if (keys.length === 0) throw new Error('The identity already has every key to add')
  const newRevision = BigInt(identity.toJSON().revision || 0) + BigInt(1)
  const maxKeyId = identity.publicKeys.reduce((max: number, key: { keyId: number }) => Math.max(max, key.keyId), 0)
  const keyIds = keys.map((key, index) => maxKeyId + 1 + index)

  // The identity nonce is the last one used: the update takes the next.
  const currentNonce = await sdk.identities.nonce(identityId)
  if (currentNonce === null || currentNonce === undefined) {
    throw new Error('Failed to fetch identity nonce')
  }
  const nextNonce = currentNonce + BigInt(1)
  logger.debug('IdentityUpdateBuilder: revision', newRevision, 'nonce', nextNonce, 'key ids', keyIds)

  // Each pass builds (and frees) its own wasm objects.
  const buildTransitionBytes = (signatures: Uint8Array[], read: (transition: InstanceType<typeof wasm.IdentityUpdateTransition>) => Uint8Array): Uint8Array => {
    const created = keys.map((key, index) => new wasm.IdentityPublicKeyInCreation({
      keyId: keyIds[index],
      purpose: key.purpose,
      securityLevel: key.securityLevel,
      keyType: key.keyType,
      isReadOnly: false,
      data: key.data,
      signature: signatures[index],
      ...(key.boundToContract ? { contractBounds: wasm.ContractBounds.SingleContract(key.boundToContract) } : {}),
    }))
    try {
      const transition = new wasm.IdentityUpdateTransition({
        identityId,
        revision: newRevision,
        nonce: nextNonce,
        addPublicKeys: created,
        disablePublicKeys: [],
      })
      try {
        return read(transition)
      } finally {
        transition.free()
      }
    } finally {
      for (const key of created) key.free()
    }
  }

  // Pass 1: the signable bytes (which exclude every signature), for the ownership proofs.
  const signableBytes = buildTransitionBytes(keys.map(() => new Uint8Array(0)), (transition) => {
    const stateTransition = transition.toStateTransition()
    try {
      return stateTransition.getSignableBytes()
    } finally {
      stateTransition.free()
    }
  })
  const signatures = await Promise.all(keys.map((key) => key.proofPrivateKey ? signWithKey(key.proofPrivateKey, signableBytes) : Promise.resolve(new Uint8Array(0))))
  // Pass 2: the same transition carrying the proofs.
  const transitionBytes = buildTransitionBytes(signatures, (transition) => transition.toBytes())
  logger.debug('IdentityUpdateBuilder: Final transition bytes length:', transitionBytes.length)
  const added = keys.map((key, index): YapprRegisteredKey => ({ keyId: keyIds[index], purpose: key.purpose, securityLevel: key.securityLevel }))
  return { transitionBytes, keys: added, identityRevision: newRevision }
}

function requireKeyLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`Invalid ${what} length: expected ${expected}, got ${bytes.length}`)
  }
}

/**
 * Build the unsigned IdentityUpdateTransition of a wallet sign-in's
 * first-login key registration (the `dash-st:` hand-off).
 *
 * The auth key stays on the hash160 workaround (no ownership proof, which
 * would reveal the full key); the encryption key (`deriveLoginEncryptionKey`)
 * is a full secp256k1 key with an ownership proof, so encrypted features can
 * use the on-chain point directly.
 *
 * Legacy builds add both keys, unbound. App Connect builds bind the
 * encryption key `singleContract(anchor)`: it is the messaging key, and must
 * be the anchor key `dm.unlock` re-derives from the auth key. They add only
 * the keys the identity lacks: never a second anchor key, which would replace
 * the one peers encrypt to.
 */
export async function buildUnsignedKeyRegistrationTransition(
  request: KeyRegistrationRequest
): Promise<UnsignedTransitionResult> {
  const { identityId, authPrivateKey, authPublicKey, encryptionPrivateKey, encryptionPublicKey } = request
  requireKeyLength(authPrivateKey, 32, 'auth private key')
  requireKeyLength(authPublicKey, 33, 'auth public key')
  requireKeyLength(encryptionPrivateKey, 32, 'encryption private key')
  requireKeyLength(encryptionPublicKey, 33, 'encryption public key')

  const auth: KeyToAdd = { purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_hash160', data: hash160(authPublicKey) }
  const encryption: KeyToAdd = { purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', data: encryptionPublicKey, proofPrivateKey: encryptionPrivateKey }
  const anchorId = messagingAnchorId()
  if (!anchorId) return buildUnsignedAddKeysTransition(identityId, () => [auth, encryption])

  const messagingKey = deriveEncryptionKey(authPrivateKey, identityId, anchorId)
  const messagingPublicKey = getPublicKey(messagingKey)
  messagingKey.fill(0)
  if (!bytesEqual(encryptionPublicKey, messagingPublicKey)) {
    throw new Error('The encryption key to register is not the messaging key this sign-in derives')
  }
  return buildUnsignedAddKeysTransition(identityId, (publicKeys) => {
    const adding: KeyToAdd[] = []
    if (!hasAuthKey(publicKeys, authPublicKey)) adding.push(auth)
    if (!hasBoundEncryptionKey(publicKeys, anchorId)) adding.push({ ...encryption, boundToContract: anchorId })
    return adding
  })
}

/**
 * Build an unsigned IdentityUpdateTransition that adds one ENCRYPTION/MEDIUM
 * ECDSA_SECP256K1 key bound `singleContract(contractId)`: the App Connect
 * messaging key, for a wallet to sign with the identity's MASTER key. Throws
 * `BoundKeyExistsError` when the identity already has one: the newest bound
 * key becomes the current one, so adding a second would orphan everything
 * peers encrypted to the first.
 */
export async function buildUnsignedBoundEncryptionKeyTransition(request: {
  identityId: string
  /** The new key's private key (32 bytes): signs its ownership proof. */
  encryptionPrivateKey: Uint8Array
  contractId: string
}): Promise<{ transitionBytes: Uint8Array; keyId: number; identityRevision: bigint }> {
  requireKeyLength(request.encryptionPrivateKey, 32, 'encryption private key')
  const { transitionBytes, keys: [{ keyId }], identityRevision } = await buildUnsignedAddKeysTransition(request.identityId, (publicKeys) => {
    if (hasBoundEncryptionKey(publicKeys, request.contractId)) throw new BoundKeyExistsError()
    return [{
      purpose: 'encryption',
      securityLevel: 'medium',
      keyType: 'ecdsa_secp256k1',
      data: getPublicKey(request.encryptionPrivateKey),
      proofPrivateKey: request.encryptionPrivateKey,
      boundToContract: request.contractId,
    }]
  })
  return { transitionBytes, keyId, identityRevision }
}

/**
 * Whether a wallet sign-in can go ahead: the identity has the keys its
 * first-login registration adds (a fresh read).
 *
 * Legacy builds: the auth key and this encryption key. App Connect builds:
 * the auth key. Messaging is not a condition of signing in there: an
 * identity without an anchor key signs in and sets messaging up from
 * Messages, and one whose anchor key is another key unlocks with that key.
 */
export async function checkKeysRegistered(
  identityId: string,
  authPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array
): Promise<boolean> {
  const sdk = await getEvoSdk()
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) {
    return false
  }
  const publicKeys = identity.publicKeys as unknown as RegisteredIdentityKey[]
  if (!hasAuthKey(publicKeys, authPublicKey)) return false
  return messagingAnchorId() !== null
    || hasKey(publicKeys, [KeyPurpose.ENCRYPTION, 'encryption'], [KeyType.ECDSA_SECP256K1, 'ecdsa_secp256k1'], encryptionPublicKey)
}
