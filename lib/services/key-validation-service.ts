import { identityService } from './identity-service'
import {
  findMatchingKeyIndex,
  getSecurityLevelName,
  getPurposeName,
  isSecurityLevelAllowedForLogin,
  isPurposeAllowedForLogin,
  type IdentityPublicKeyInfo
} from '@/lib/crypto/keys'
import { wifToPrivateKey, validateWifNetwork } from '@/lib/crypto/wif'
import bs58 from 'bs58'

export type KeyValidationErrorType =
  | 'INVALID_WIF'
  | 'NO_MATCH'
  | 'WRONG_PURPOSE'
  | 'WRONG_SECURITY_LEVEL'
  | 'NETWORK_MISMATCH'
  | 'IDENTITY_NOT_FOUND'

export interface KeyValidationResult {
  isValid: boolean
  keyId?: number
  securityLevel?: number
  securityLevelName?: string
  purpose?: number
  purposeName?: string
  error?: string
  errorType?: KeyValidationErrorType
}

/**
 * Convert SDK public key data to Uint8Array
 * Handles multiple formats: Uint8Array, Array, base58 string, base64 string
 */
function extractPublicKeyBytes(data: unknown): Uint8Array | null {
  if (!data) return null

  // Already a Uint8Array
  if (data instanceof Uint8Array) {
    return data
  }

  // Array of numbers
  if (Array.isArray(data)) {
    return new Uint8Array(data)
  }

  // String - try base58 first (common for Dash), then base64
  if (typeof data === 'string') {
    try {
      // Try base58 decode
      return bs58.decode(data)
    } catch {
      try {
        // Try base64 decode
        const binary = atob(data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        return bytes
      } catch {
        return null
      }
    }
  }

  return null
}

interface SDKPublicKey {
  id?: number;
  keyId?: number;
  purpose?: number;
  securityLevel?: number;
  data?: unknown;
  publicKey?: unknown;
}

/**
 * Convert SDK public key format to our internal format
 */
function convertPublicKeys(sdkPublicKeys: SDKPublicKey[]): IdentityPublicKeyInfo[] {
  const result: IdentityPublicKeyInfo[] = []

  for (const key of sdkPublicKeys) {
    // Handle various field names for the data
    const rawData = key.data || key.publicKey

    const data = extractPublicKeyBytes(rawData)
    if (!data) {
      console.warn('Could not extract public key bytes for key:', key.id)
      continue
    }

    result.push({
      id: key.id ?? key.keyId ?? 0,
      type: key.type ?? key.keyType ?? 0,
      purpose: key.purpose ?? 0,
      securityLevel: key.securityLevel ?? 0,
      data
    })
  }

  return result
}

class KeyValidationService {
  /**
   * Validate a WIF private key against an identity's public keys
   * Checks that the key matches, has proper purpose, and sufficient security level
   */
  async validatePrivateKey(
    privateKeyWif: string,
    identityId: string,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<KeyValidationResult> {
    // First, validate WIF format and network
    try {
      const decoded = wifToPrivateKey(privateKeyWif)
      if (!validateWifNetwork(decoded.prefix, network)) {
        return {
          isValid: false,
          error: 'This key is for a different network',
          errorType: 'NETWORK_MISMATCH'
        }
      }
    } catch {
      return {
        isValid: false,
        error: 'Invalid private key format',
        errorType: 'INVALID_WIF'
      }
    }

    // Fetch identity public keys
    const identity = await identityService.getIdentity(identityId)
    if (!identity) {
      return {
        isValid: false,
        error: 'Identity not found',
        errorType: 'IDENTITY_NOT_FOUND'
      }
    }

    // Convert SDK format to our format
    const publicKeys = convertPublicKeys(identity.publicKeys)

    // Find matching key
    const match = findMatchingKeyIndex(privateKeyWif, publicKeys, network)

    if (!match) {
      return {
        isValid: false,
        error: 'This key does not match this identity',
        errorType: 'NO_MATCH'
      }
    }

    // Check purpose (must be AUTHENTICATION)
    if (!isPurposeAllowedForLogin(match.purpose)) {
      return {
        isValid: false,
        keyId: match.keyId,
        securityLevel: match.securityLevel,
        securityLevelName: getSecurityLevelName(match.securityLevel),
        purpose: match.purpose,
        purposeName: getPurposeName(match.purpose),
        error: `This key cannot be used for authentication (it's a ${getPurposeName(match.purpose)} key)`,
        errorType: 'WRONG_PURPOSE'
      }
    }

    // Check security level (must be CRITICAL or HIGH)
    if (!isSecurityLevelAllowedForLogin(match.securityLevel)) {
      const levelName = getSecurityLevelName(match.securityLevel)
      // MASTER (0) is more powerful than CRITICAL/HIGH but shouldn't be used for login
      // MEDIUM (3) and lower are insufficient
      const errorMessage = match.securityLevel === 0
        ? `This is your MASTER key - keep it safe! Use a HIGH or CRITICAL authentication key instead.`
        : `This key's security level is too low (${levelName}) - need HIGH or CRITICAL`
      return {
        isValid: false,
        keyId: match.keyId,
        securityLevel: match.securityLevel,
        securityLevelName: levelName,
        purpose: match.purpose,
        purposeName: getPurposeName(match.purpose),
        error: errorMessage,
        errorType: 'WRONG_SECURITY_LEVEL'
      }
    }

    // All validations passed
    return {
      isValid: true,
      keyId: match.keyId,
      securityLevel: match.securityLevel,
      securityLevelName: getSecurityLevelName(match.securityLevel),
      purpose: match.purpose,
      purposeName: getPurposeName(match.purpose)
    }
  }

  /**
   * Quick check if a WIF format is valid (doesn't check against identity)
   */
  isValidWifFormat(privateKeyWif: string): boolean {
    try {
      wifToPrivateKey(privateKeyWif)
      return true
    } catch {
      return false
    }
  }
}

export const keyValidationService = new KeyValidationService()
