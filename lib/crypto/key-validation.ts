import { parsePrivateKey } from './wif'

/**
 * Key purpose constants matching Dash Platform identity key purposes
 */
export const KEY_PURPOSE = {
  AUTHENTICATION: 0,
  ENCRYPTION: 1,
  DECRYPTION: 2,
  TRANSFER: 3,
} as const

export type KeyPurpose = (typeof KEY_PURPOSE)[keyof typeof KEY_PURPOSE]

/**
 * Error types for key validation failures
 */
export type KeyValidationErrorType =
  | 'INVALID_KEY_FORMAT'
  | 'IDENTITY_NOT_FOUND'
  | 'NO_KEY_ON_IDENTITY'
  | 'KEY_MISMATCH'

/**
 * Match types for successful validation
 */
export type KeyMatchType =
  | 'EXACT_MATCH' // Key matches the on-chain key exactly
  | 'DERIVATION_MATCH' // Key was derived from auth key and matches

export interface KeyValidationResult {
  isValid: boolean
  privateKey?: Uint8Array
  publicKey?: Uint8Array
  keyId?: number
  matchType?: KeyMatchType
  error?: string
  errorType?: KeyValidationErrorType
  noKeyOnIdentity?: boolean
}

// Legacy type aliases for backwards compatibility
export type EncryptionKeyValidationErrorType = KeyValidationErrorType
export type EncryptionKeyValidationResult = KeyValidationResult

/**
 * Parse public key data from identity (can be Uint8Array, hex string, or base64)
 */
export function parsePublicKeyData(data: unknown): Uint8Array | null {
  if (!data) return null

  if (data instanceof Uint8Array) {
    return data
  }

  if (typeof data === 'string') {
    // Check if hex (must be even length for valid hex encoding)
    if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) {
      const bytes = new Uint8Array(data.length / 2)
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(data.substring(i * 2, i * 2 + 2), 16)
      }
      return bytes
    }
    // Try base64
    try {
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    } catch {
      // Invalid base64
      return null
    }
  }

  return null
}

/**
 * Compare two Uint8Arrays for equality
 */
function areEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Get human-readable name for key purpose
 */
function getPurposeName(purpose: KeyPurpose): string {
  switch (purpose) {
    case KEY_PURPOSE.AUTHENTICATION:
      return 'authentication'
    case KEY_PURPOSE.ENCRYPTION:
      return 'encryption'
    case KEY_PURPOSE.DECRYPTION:
      return 'decryption'
    case KEY_PURPOSE.TRANSFER:
      return 'transfer'
    default:
      return 'unknown'
  }
}

/**
 * Validate that the provided key matches a key on the user's identity for the given purpose.
 *
 * This is a general validation function that works for any key type (encryption, transfer, etc.)
 *
 * @param keyInput - The key in WIF or hex format
 * @param identityId - The user's identity ID
 * @param purpose - The key purpose (1=encryption, 3=transfer)
 * @param matchType - Optional match type to set on success (defaults to 'EXACT_MATCH')
 * @returns Validation result with the parsed key if valid
 */
export async function validateKey(
  keyInput: string,
  identityId: string,
  purpose: KeyPurpose,
  matchType: KeyMatchType = 'EXACT_MATCH'
): Promise<KeyValidationResult> {
  const purposeName = getPurposeName(purpose)

  // Step 1: Parse the key (WIF or hex)
  let keyBytes: Uint8Array
  try {
    const parsed = parsePrivateKey(keyInput.trim())
    keyBytes = parsed.privateKey
  } catch (parseError) {
    return {
      isValid: false,
      error: parseError instanceof Error ? parseError.message : 'Invalid key format',
      errorType: 'INVALID_KEY_FORMAT',
    }
  }

  // Step 2: Derive public key from private key
  const { privateFeedCryptoService } = await import('@/lib/services')
  let derivedPubKey: Uint8Array
  try {
    derivedPubKey = privateFeedCryptoService.getPublicKey(keyBytes)
  } catch {
    return {
      isValid: false,
      error: 'Invalid private key format',
      errorType: 'INVALID_KEY_FORMAT',
    }
  }

  // Step 3: Fetch user's identity
  const { identityService } = await import('@/lib/services/identity-service')
  const identityData = await identityService.getIdentity(identityId)
  if (!identityData) {
    return {
      isValid: false,
      error: 'Could not fetch identity data',
      errorType: 'IDENTITY_NOT_FOUND',
    }
  }

  // Step 4: Find all candidate keys on identity (purpose specified, type = 0 for ECDSA_SECP256K1)
  // Exclude disabled keys (check both camelCase and snake_case variants)
  const candidateKeys = identityData.publicKeys.filter(
    (key) => key.purpose === purpose && key.type === 0 && !key.disabledAt && !key.disabled_at
  )

  if (candidateKeys.length === 0) {
    return {
      isValid: false,
      error: `No ${purposeName} key found on your identity.`,
      errorType: 'NO_KEY_ON_IDENTITY',
      noKeyOnIdentity: true,
    }
  }

  // Step 5: Check each candidate key for a match
  for (const targetKey of candidateKeys) {
    const onChainPubKeyBytes = parsePublicKeyData(targetKey.data)
    if (onChainPubKeyBytes) {
      const matches = areEqual(derivedPubKey, onChainPubKeyBytes)
      if (matches) {
        // Key is valid - found a match
        return {
          isValid: true,
          privateKey: keyBytes,
          publicKey: derivedPubKey,
          keyId: targetKey.id,
          matchType,
        }
      }
    }
  }

  // No matching key found among candidates
  return {
    isValid: false,
    error: `This key does not match the ${purposeName} key on your identity`,
    errorType: 'KEY_MISMATCH',
  }
}

/**
 * Validate that the provided key matches the encryption key (purpose=1, type=0)
 * on the user's identity.
 *
 * This prevents users from accidentally using auth/high keys for encryption operations.
 *
 * @param keyInput - The key in WIF or hex format
 * @param identityId - The user's identity ID
 * @param matchType - Optional match type to set on success (defaults to 'EXACT_MATCH')
 * @returns Validation result with the parsed key if valid
 */
export async function validateEncryptionKey(
  keyInput: string,
  identityId: string,
  matchType: KeyMatchType = 'EXACT_MATCH'
): Promise<KeyValidationResult> {
  return validateKey(keyInput, identityId, KEY_PURPOSE.ENCRYPTION, matchType)
}

/**
 * Validate that the provided key matches the transfer key (purpose=3, type=0)
 * on the user's identity.
 *
 * This prevents users from accidentally using wrong keys for transfer/tip operations.
 *
 * @param keyInput - The key in WIF or hex format
 * @param identityId - The user's identity ID
 * @param matchType - Optional match type to set on success (defaults to 'EXACT_MATCH')
 * @returns Validation result with the parsed key if valid
 */
export async function validateTransferKey(
  keyInput: string,
  identityId: string,
  matchType: KeyMatchType = 'EXACT_MATCH'
): Promise<KeyValidationResult> {
  return validateKey(keyInput, identityId, KEY_PURPOSE.TRANSFER, matchType)
}

/**
 * Validate a key from raw bytes (useful when working with derived keys)
 *
 * @param keyBytes - The private key as Uint8Array
 * @param identityId - The user's identity ID
 * @param purpose - The key purpose (1=encryption, 3=transfer)
 * @param matchType - Optional match type to set on success (defaults to 'EXACT_MATCH')
 * @returns Validation result
 */
export async function validateKeyBytes(
  keyBytes: Uint8Array,
  identityId: string,
  purpose: KeyPurpose,
  matchType: KeyMatchType = 'EXACT_MATCH'
): Promise<KeyValidationResult> {
  const purposeName = getPurposeName(purpose)

  // Step 1: Derive public key from private key
  const { privateFeedCryptoService } = await import('@/lib/services')
  let derivedPubKey: Uint8Array
  try {
    derivedPubKey = privateFeedCryptoService.getPublicKey(keyBytes)
  } catch {
    return {
      isValid: false,
      error: 'Invalid private key format',
      errorType: 'INVALID_KEY_FORMAT',
    }
  }

  // Step 2: Fetch user's identity
  const { identityService } = await import('@/lib/services/identity-service')
  const identityData = await identityService.getIdentity(identityId)
  if (!identityData) {
    return {
      isValid: false,
      error: 'Could not fetch identity data',
      errorType: 'IDENTITY_NOT_FOUND',
    }
  }

  // Step 3: Find all candidate keys on identity (purpose specified, type = 0 for ECDSA_SECP256K1)
  // Exclude disabled keys (check both camelCase and snake_case variants)
  const candidateKeys = identityData.publicKeys.filter(
    (key) => key.purpose === purpose && key.type === 0 && !key.disabledAt && !key.disabled_at
  )

  if (candidateKeys.length === 0) {
    return {
      isValid: false,
      error: `No ${purposeName} key found on your identity.`,
      errorType: 'NO_KEY_ON_IDENTITY',
      noKeyOnIdentity: true,
    }
  }

  // Step 4: Check each candidate key for a match
  for (const targetKey of candidateKeys) {
    const onChainPubKeyBytes = parsePublicKeyData(targetKey.data)
    if (onChainPubKeyBytes) {
      const matches = areEqual(derivedPubKey, onChainPubKeyBytes)
      if (matches) {
        // Key is valid - found a match
        return {
          isValid: true,
          privateKey: keyBytes,
          publicKey: derivedPubKey,
          keyId: targetKey.id,
          matchType,
        }
      }
    }
  }

  // No matching key found among candidates
  return {
    isValid: false,
    error: `This key does not match the ${purposeName} key on your identity`,
    errorType: 'KEY_MISMATCH',
  }
}
