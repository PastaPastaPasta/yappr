/**
 * Identity Update Builder Service
 *
 * Builds unsigned IdentityUpdateTransition state transitions for wallet signing.
 * This service creates the transition bytes that get encoded into a dash-st: URI
 * for the wallet to sign and broadcast.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md Section 11.5
 */

import { logger } from '@/lib/logger'
import { getEvoSdk } from './evo-sdk-service'
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed'
import * as secp256k1 from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hash160 } from '../crypto/hash'
import { getPublicKey } from '../crypto/keys'
import { requireBytes } from '@/lib/bytes'
import { KeyPurpose, KeyType } from '@/lib/crypto/identity-keys'

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
  /** The auth key ID that will be assigned */
  authKeyId: number
  /** The encryption key ID that will be assigned */
  encryptionKeyId: number
  /** Current identity revision */
  identityRevision: bigint
}

// Dash/Bitcoin compact signature header constants
const COMPACT_SIG_BASE = 27
const COMPACT_SIG_COMPRESSED_FLAG = 4

type RegisteredIdentityKey = {
  purpose?: string | number
  purposeNumber?: number
  keyType?: string | number
  keyTypeNumber?: number
  type?: number
  data?: string
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

/**
 * Build an unsigned IdentityUpdateTransition adding `keys` (ids assigned in
 * order after the identity's highest). Each key with a `proofPrivateKey`
 * signs the transition's signable bytes to prove ownership; the transition
 * itself is NOT signed: the wallet signs it with a MASTER key.
 */
async function buildUnsignedAddKeysTransition(
  identityId: string,
  keys: KeyToAdd[],
): Promise<{ transitionBytes: Uint8Array; keyIds: number[]; identityRevision: bigint }> {
  const sdk = await getEvoSdk()
  const wasm = await ensureWasmInitialized()

  logger.debug('IdentityUpdateBuilder: Fetching identity', identityId)
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) {
    throw new Error(`Identity not found: ${identityId}`)
  }
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
  return { transitionBytes, keyIds, identityRevision: newRevision }
}

function requireKeyLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`Invalid ${what} length: expected ${expected}, got ${bytes.length}`)
  }
}

/**
 * Build an unsigned IdentityUpdateTransition for key registration.
 *
 * This creates a state transition that adds auth and encryption keys to an identity.
 * Each new key signs the transition's signable bytes to prove ownership.
 * The overall transition is NOT signed by a master key - that's for the wallet to do.
 *
 * @param request - The key registration request
 * @returns The transition bytes (with key signatures) and key IDs
 */
export async function buildUnsignedKeyRegistrationTransition(
  request: KeyRegistrationRequest
): Promise<UnsignedTransitionResult> {
  const { identityId, authPrivateKey, authPublicKey, encryptionPrivateKey, encryptionPublicKey } = request
  requireKeyLength(authPrivateKey, 32, 'auth private key')
  requireKeyLength(authPublicKey, 33, 'auth public key')
  requireKeyLength(encryptionPrivateKey, 32, 'encryption private key')
  requireKeyLength(encryptionPublicKey, 33, 'encryption public key')

  // The auth key stays on the hash160 workaround (no ownership proof, which
  // would reveal the full key); the encryption key is a full secp256k1 key so
  // encrypted features can use the on-chain point directly. Both are unbound
  // here: this is the legacy login's registration.
  const { transitionBytes, keyIds: [authKeyId, encryptionKeyId], identityRevision } = await buildUnsignedAddKeysTransition(identityId, [
    { purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_hash160', data: hash160(authPublicKey) },
    { purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', data: encryptionPublicKey, proofPrivateKey: encryptionPrivateKey },
  ])
  return { transitionBytes, authKeyId, encryptionKeyId, identityRevision }
}

/**
 * Build an unsigned IdentityUpdateTransition that adds one ENCRYPTION/MEDIUM
 * ECDSA_SECP256K1 key bound `singleContract(contractId)`: the App Connect
 * messaging key, for a wallet to sign with the identity's MASTER key.
 */
export async function buildUnsignedBoundEncryptionKeyTransition(request: {
  identityId: string
  /** The new key's private key (32 bytes): signs its ownership proof. */
  encryptionPrivateKey: Uint8Array
  contractId: string
}): Promise<{ transitionBytes: Uint8Array; keyId: number; identityRevision: bigint }> {
  requireKeyLength(request.encryptionPrivateKey, 32, 'encryption private key')
  const { transitionBytes, keyIds: [keyId], identityRevision } = await buildUnsignedAddKeysTransition(request.identityId, [{
    purpose: 'encryption',
    securityLevel: 'medium',
    keyType: 'ecdsa_secp256k1',
    data: getPublicKey(request.encryptionPrivateKey),
    proofPrivateKey: request.encryptionPrivateKey,
    boundToContract: request.contractId,
  }])
  return { transitionBytes, keyId, identityRevision }
}

/**
 * Check if an identity has the expected keys registered.
 *
 * @param identityId - The identity ID to check
 * @param authPublicKey - Expected auth public key (33 bytes)
 * @param encryptionPublicKey - Expected encryption public key (33 bytes)
 * @returns True if both keys exist on the identity
 */
export async function checkKeysRegistered(
  identityId: string,
  authPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array
): Promise<boolean> {
  const sdk = await getEvoSdk()

  // Fetch fresh identity data
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) {
    return false
  }

  const publicKeys = identity.publicKeys

  // Helper to extract key data as Uint8Array from a WASM IdentityPublicKey.
  // The WASM `.data` getter returns a hex string; `.toJSON().data` may differ.
  // Try the direct `.data` hex property first, then toJSON as fallback.
  const getKeyData = (key: RegisteredIdentityKey): Uint8Array =>
    requireBytes(key.data ?? key.toJSON().data, 'identity key data')

  const authHash = hash160(authPublicKey)

  // Check for auth key (purpose=AUTHENTICATION, keyType=ECDSA_HASH160)
  const authKeyExists = publicKeys.some((key: RegisteredIdentityKey) => {
    if (!keyMatchesPurposeAndType(key, KeyPurpose.AUTHENTICATION, 'authentication', KeyType.ECDSA_HASH160, 'ecdsa_hash160')) {
      return false
    }
    const keyData = getKeyData(key)
    if (keyData.length !== authHash.length) {
      return false
    }
    return keyData.every((b: number, i: number) => b === authHash[i])
  })

  // Check for encryption key (purpose=ENCRYPTION, keyType=ECDSA_SECP256K1)
  const encKeyExists = publicKeys.some((key: RegisteredIdentityKey) => {
    if (!keyMatchesPurposeAndType(key, KeyPurpose.ENCRYPTION, 'encryption', KeyType.ECDSA_SECP256K1, 'ecdsa_secp256k1')) {
      return false
    }
    const keyData = getKeyData(key)
    if (keyData.length !== encryptionPublicKey.length) {
      return false
    }
    return keyData.every((b: number, i: number) => b === encryptionPublicKey[i])
  })

  return authKeyExists && encKeyExists
}
