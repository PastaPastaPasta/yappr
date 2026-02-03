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

let wasmInitialized = false
async function ensureWasmInitialized() {
  if (!wasmInitialized) {
    await initWasm()
    wasmInitialized = true
  }
  return wasmSdk
}

/**
 * Key registration request containing the public keys to add
 */
export interface KeyRegistrationRequest {
  /** Identity ID (Base58) */
  identityId: string
  /** Auth key public key bytes (33 bytes compressed) */
  authPublicKey: Uint8Array
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
 * Build an unsigned IdentityUpdateTransition for key registration.
 *
 * This creates a state transition that adds auth and encryption keys to an identity.
 * The transition is NOT signed - it's returned as bytes to be encoded in a dash-st: URI
 * for the wallet to sign.
 *
 * @param request - The key registration request
 * @returns The unsigned transition bytes and key IDs
 */
export async function buildUnsignedKeyRegistrationTransition(
  request: KeyRegistrationRequest
): Promise<UnsignedTransitionResult> {
  const { identityId, authPublicKey, encryptionPublicKey } = request

  // Validate inputs
  if (authPublicKey.length !== 33) {
    throw new Error(`Invalid auth public key length: expected 33, got ${authPublicKey.length}`)
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

  // Fetch identity nonce
  console.log('IdentityUpdateBuilder: Fetching identity nonce')
  const nonce = await sdk.identities.nonce(identityId)
  if (nonce === null) {
    throw new Error('Failed to fetch identity nonce')
  }
  console.log('IdentityUpdateBuilder: Nonce:', nonce)

  // Create IdentityPublicKeyInCreation for auth key
  // Constructor: (id, purpose, securityLevel, keyType, readOnly, data, signature, contractBounds)
  // - purpose: 'AUTHENTICATION' (0)
  // - securityLevel: 'HIGH' (2) - auth keys should be HIGH
  // - keyType: 'ECDSA_SECP256K1' (0)
  console.log('IdentityUpdateBuilder: Creating auth key')
  const authKey = new wasm.IdentityPublicKeyInCreation(
    authKeyId,
    'AUTHENTICATION',  // purpose
    'HIGH',            // securityLevel
    'ECDSA_SECP256K1', // keyType
    false,             // readOnly
    authPublicKey,     // data
    null,              // signature (will be set by wallet)
    null               // contractBounds
  )

  // Create IdentityPublicKeyInCreation for encryption key
  // - purpose: 'ENCRYPTION' (1)
  // - securityLevel: 'MEDIUM' (3) - encryption keys use MEDIUM
  console.log('IdentityUpdateBuilder: Creating encryption key')
  const encryptionKey = new wasm.IdentityPublicKeyInCreation(
    encryptionKeyId,
    'ENCRYPTION',      // purpose
    'MEDIUM',          // securityLevel
    'ECDSA_SECP256K1', // keyType
    false,             // readOnly
    encryptionPublicKey, // data
    null,              // signature (will be set by wallet)
    null               // contractBounds
  )

  // Create IdentityUpdateTransition
  // Constructor: (identityId, revision, nonce, addPublicKeys, disablePublicKeys, userFeeIncrease)
  const newRevision = currentRevision + BigInt(1)
  console.log('IdentityUpdateBuilder: Creating IdentityUpdateTransition with revision:', newRevision)

  const transition = new wasm.IdentityUpdateTransition(
    identityId,               // identity ID (can be string)
    newRevision,              // revision (current + 1)
    nonce,                    // nonce from sdk.identities.nonce()
    [authKey, encryptionKey], // keys to add
    new Uint32Array([]),      // keys to disable (empty)
    null                      // user fee increase
  )

  // Get the signable bytes - this is what the wallet needs to sign
  // Note: toBytes() gives us the full transition bytes
  const transitionBytes = transition.toBytes()
  console.log('IdentityUpdateBuilder: Transition bytes length:', transitionBytes.length)

  // Clean up WASM objects
  authKey.free()
  encryptionKey.free()
  transition.free()

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
