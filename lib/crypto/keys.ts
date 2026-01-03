import * as secp256k1 from '@noble/secp256k1'
import { hash160 } from './hash'
import { wifToPrivateKey, validateWifNetwork, TESTNET_WIF_PREFIX, MAINNET_WIF_PREFIX } from './wif'

export interface IdentityPublicKeyInfo {
  id: number
  type: number           // 0=ECDSA_SECP256K1, 2=ECDSA_HASH160
  purpose: number        // 0=AUTH, 1=ENCRYPTION, etc.
  securityLevel: number  // 0=MASTER, 1=CRITICAL, 2=HIGH, 3=MEDIUM
  data: Uint8Array
}

export interface KeyMatchResult {
  keyId: number
  securityLevel: number
  purpose: number
  publicKey: Uint8Array
}

/**
 * Get compressed public key from private key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

/**
 * Compare two Uint8Arrays for equality
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Find which identity key matches the given private key WIF.
 * Returns the matching key info including id, securityLevel, and purpose, or null if no match.
 */
export function findMatchingKeyIndex(
  privateKeyWif: string,
  identityPublicKeys: IdentityPublicKeyInfo[],
  network: 'testnet' | 'mainnet'
): KeyMatchResult | null {
  // Decode the WIF to get the private key
  let privateKey: Uint8Array
  try {
    const decoded = wifToPrivateKey(privateKeyWif)
    privateKey = decoded.privateKey

    // Validate network prefix
    if (!validateWifNetwork(decoded.prefix, network)) {
      return null // Network mismatch
    }
  } catch {
    return null // Invalid WIF format
  }

  // Derive the public key from the private key
  const publicKey = getPublicKey(privateKey)
  const publicKeyHash = hash160(publicKey)

  // Check against each identity key
  for (const key of identityPublicKeys) {
    // Key type 0 = ECDSA_SECP256K1 (33-byte compressed public key)
    // Key type 2 = ECDSA_HASH160 (20-byte hash160)
    if (key.type === 0) {
      // Compare full public key
      if (bytesEqual(publicKey, key.data)) {
        return { keyId: key.id, securityLevel: key.securityLevel, purpose: key.purpose, publicKey }
      }
    } else if (key.type === 2) {
      // Compare hash160
      if (bytesEqual(publicKeyHash, key.data)) {
        return { keyId: key.id, securityLevel: key.securityLevel, purpose: key.purpose, publicKey }
      }
    }
  }

  return null
}

/**
 * Get security level name from numeric value
 */
export function getSecurityLevelName(level: number): string {
  switch (level) {
    case 0: return 'MASTER'
    case 1: return 'CRITICAL'
    case 2: return 'HIGH'
    case 3: return 'MEDIUM'
    default: return `UNKNOWN(${level})`
  }
}

/**
 * Get purpose name from numeric value
 */
export function getPurposeName(purpose: number): string {
  switch (purpose) {
    case 0: return 'AUTHENTICATION'
    case 1: return 'ENCRYPTION'
    case 2: return 'DECRYPTION'
    case 3: return 'TRANSFER'
    case 4: return 'OWNER'
    case 5: return 'VOTING'
    default: return `UNKNOWN(${purpose})`
  }
}

/**
 * Check if a security level is allowed for login/DPNS
 * Only CRITICAL (1) and HIGH (2) are allowed
 */
export function isSecurityLevelAllowedForLogin(level: number): boolean {
  return level === 1 || level === 2
}

/**
 * Check if a key purpose is allowed for login
 * Only AUTHENTICATION (0) is allowed
 */
export function isPurposeAllowedForLogin(purpose: number): boolean {
  return purpose === 0
}
