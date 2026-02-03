/**
 * Identity Update Builder Service
 *
 * Builds unsigned IdentityUpdateTransition state transitions for wallet signing.
 * This service creates the transition bytes that get encoded into a dash-st: URI
 * for the wallet to sign and broadcast.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md Section 11.5
 */

import { getEvoSdk } from './evo-sdk-service'
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed'
import * as secp256k1 from '@noble/secp256k1'

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

/**
 * Sign data with a private key using secp256k1 (compact signature format).
 * Returns a 65-byte signature: recovery (1) + r (32) + s (32)
 */
async function signWithKey(privateKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Sign with recovery byte format (65 bytes)
  // Using prehash: true (default) means it will sha256 the data for us
  const signature = await secp256k1.signAsync(data, privateKey, { format: 'recovered' })

  // The 'recovered' format returns 65 bytes: r (32) + s (32) + recovery (1)
  // But Dash expects: recovery (1) + r (32) + s (32)
  // Rearrange the bytes
  const result = new Uint8Array(65)
  result[0] = signature[64] + 27 // Recovery byte at end, move to front (add 27 for uncompressed)
  result.set(signature.slice(0, 64), 1) // r + s after recovery byte

  return result
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

  // Validate inputs
  if (authPrivateKey.length !== 32) {
    throw new Error(`Invalid auth private key length: expected 32, got ${authPrivateKey.length}`)
  }
  if (authPublicKey.length !== 33) {
    throw new Error(`Invalid auth public key length: expected 33, got ${authPublicKey.length}`)
  }
  if (encryptionPrivateKey.length !== 32) {
    throw new Error(`Invalid encryption private key length: expected 32, got ${encryptionPrivateKey.length}`)
  }
  if (encryptionPublicKey.length !== 33) {
    throw new Error(`Invalid encryption public key length: expected 33, got ${encryptionPublicKey.length}`)
  }

  const sdk = await getEvoSdk()
  const wasm = await ensureWasmInitialized()

  // Fetch identity to get current revision and existing keys
  console.log('IdentityUpdateBuilder: Fetching identity', identityId)
  const identity = await sdk.identities.fetch(identityId)
  if (!identity) {
    throw new Error(`Identity not found: ${identityId}`)
  }

  const identityJson = identity.toJSON()
  const currentRevision = BigInt(identityJson.revision || 0)
  console.log('IdentityUpdateBuilder: Current revision:', currentRevision)

  // Get existing keys to calculate next key IDs
  const existingKeys = identity.getPublicKeys()
  const maxKeyId = existingKeys.reduce((max, key) => Math.max(max, key.keyId), 0)
  const authKeyId = maxKeyId + 1
  const encryptionKeyId = maxKeyId + 2
  console.log('IdentityUpdateBuilder: Key IDs - auth:', authKeyId, ', encryption:', encryptionKeyId)

  // Fetch identity nonce - returns the last used nonce, so we need +1 for the next one
  console.log('IdentityUpdateBuilder: Fetching identity nonce')
  const currentNonce = await sdk.identities.nonce(identityId)
  if (currentNonce === null) {
    throw new Error('Failed to fetch identity nonce')
  }
  const nextNonce = currentNonce + BigInt(1)
  console.log('IdentityUpdateBuilder: Current nonce:', currentNonce, ', next nonce:', nextNonce)

  const newRevision = currentRevision + BigInt(1)

  // Step 1: Create keys with empty signatures initially
  console.log('IdentityUpdateBuilder: Creating keys with empty signatures')
  const authKey = new wasm.IdentityPublicKeyInCreation(
    authKeyId,
    'AUTHENTICATION',
    'HIGH',
    'ECDSA_SECP256K1',
    false,
    authPublicKey,
    new Uint8Array(0),  // Empty signature initially
    null
  )

  const encryptionKey = new wasm.IdentityPublicKeyInCreation(
    encryptionKeyId,
    'ENCRYPTION',
    'MEDIUM',
    'ECDSA_SECP256K1',
    false,
    encryptionPublicKey,
    new Uint8Array(0),  // Empty signature initially
    null
  )

  // Step 2: Create the transition to get signable bytes
  console.log('IdentityUpdateBuilder: Creating transition for signable bytes')
  const transition = new wasm.IdentityUpdateTransition(
    identityId,
    newRevision,
    nextNonce,
    [authKey, encryptionKey],
    new Uint32Array([]),
    null
  )

  // Step 3: Get signable bytes
  const signableBytes = transition.getSignableBytes()
  console.log('IdentityUpdateBuilder: Signable bytes length:', signableBytes.length)

  // Step 4: Sign with each new key's private key
  console.log('IdentityUpdateBuilder: Signing with auth key')
  const authSignature = await signWithKey(authPrivateKey, signableBytes)
  console.log('IdentityUpdateBuilder: Auth signature length:', authSignature.length)

  console.log('IdentityUpdateBuilder: Signing with encryption key')
  const encryptionSignature = await signWithKey(encryptionPrivateKey, signableBytes)
  console.log('IdentityUpdateBuilder: Encryption signature length:', encryptionSignature.length)

  // Clean up initial objects
  authKey.free()
  encryptionKey.free()
  transition.free()

  // Step 5: Recreate keys with signatures
  console.log('IdentityUpdateBuilder: Recreating keys with signatures')
  const authKeyWithSig = new wasm.IdentityPublicKeyInCreation(
    authKeyId,
    'AUTHENTICATION',
    'HIGH',
    'ECDSA_SECP256K1',
    false,
    authPublicKey,
    authSignature,
    null
  )

  const encryptionKeyWithSig = new wasm.IdentityPublicKeyInCreation(
    encryptionKeyId,
    'ENCRYPTION',
    'MEDIUM',
    'ECDSA_SECP256K1',
    false,
    encryptionPublicKey,
    encryptionSignature,
    null
  )

  // Step 6: Create final transition with signed keys
  console.log('IdentityUpdateBuilder: Creating final transition with signed keys')
  const finalTransition = new wasm.IdentityUpdateTransition(
    identityId,
    newRevision,
    nextNonce,
    [authKeyWithSig, encryptionKeyWithSig],
    new Uint32Array([]),
    null
  )

  // Get the final transition bytes
  const transitionBytes = finalTransition.toBytes()
  console.log('IdentityUpdateBuilder: Final transition bytes length:', transitionBytes.length)

  // Clean up WASM objects
  authKeyWithSig.free()
  encryptionKeyWithSig.free()
  finalTransition.free()

  return {
    transitionBytes,
    authKeyId,
    encryptionKeyId,
    identityRevision: newRevision
  }
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

  const publicKeys = identity.getPublicKeys()

  // Helper to extract key data as Uint8Array from IdentityPublicKey
  const getKeyData = (key: { toJSON: () => { data: string | Uint8Array } }): Uint8Array => {
    const keyJson = key.toJSON()
    const data = keyJson.data
    if (data instanceof Uint8Array) {
      return data
    }
    // Check if it's hex encoded (only hex characters)
    if (/^[0-9a-fA-F]+$/.test(data)) {
      const bytes = new Uint8Array(data.length / 2)
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(data.substr(i * 2, 2), 16)
      }
      return bytes
    }
    // Otherwise assume base64 encoded string
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  // Check for auth key (purpose='AUTHENTICATION')
  const authKeyExists = publicKeys.some(key => {
    if (key.purpose !== 'AUTHENTICATION' || key.keyType !== 'ECDSA_SECP256K1') {
      return false
    }
    const keyData = getKeyData(key)
    if (keyData.length !== authPublicKey.length) {
      return false
    }
    return keyData.every((b: number, i: number) => b === authPublicKey[i])
  })

  // Check for encryption key (purpose='ENCRYPTION')
  const encKeyExists = publicKeys.some(key => {
    if (key.purpose !== 'ENCRYPTION' || key.keyType !== 'ECDSA_SECP256K1') {
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
