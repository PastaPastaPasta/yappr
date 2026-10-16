import { findMatchingKeyIndex, matchIdentityKey, toKeyInfo, type IdentityKeyLike, type IdentityPublicKeyInfo, type KeyMatchResult } from '@/lib/crypto/keys'
import {
  KeyPurpose,
  SecurityLevel,
  getPurposeName,
  getSecurityLevelName,
} from '@/lib/crypto/identity-keys'
import { validateWifNetwork, wifToPrivateKey } from '@/lib/crypto/wif'

type LoginKeyErrorType =
  | 'INVALID_WIF'
  | 'NO_MATCH'
  | 'DISABLED'
  | 'WRONG_PURPOSE'
  | 'WRONG_SECURITY_LEVEL'
  | 'NETWORK_MISMATCH'
  | 'IDENTITY_NOT_FOUND'

export interface LoginKeyResult {
  isValid: boolean
  keyId?: number
  securityLevel?: number
  securityLevelName?: string
  purpose?: number
  purposeName?: string
  error?: string
  errorType?: LoginKeyErrorType
}

/** The keys a typed-in key may sign in with: the identity's enabled CRITICAL or HIGH authentication keys. */
const LOGIN_LEVELS = [SecurityLevel.CRITICAL, SecurityLevel.HIGH] as const

function keyFacts(match: KeyMatchResult): Pick<LoginKeyResult, 'keyId' | 'securityLevel' | 'securityLevelName' | 'purpose' | 'purposeName'> {
  return {
    keyId: match.keyId,
    securityLevel: match.securityLevel,
    securityLevelName: getSecurityLevelName(match.securityLevel),
    purpose: match.purpose,
    purposeName: getPurposeName(match.purpose),
  }
}

/** Why a key that matched an enabled identity key of the wrong kind can't sign in. */
function rejection(match: KeyMatchResult): LoginKeyResult {
  const base = { isValid: false, ...keyFacts(match) }
  if (match.purpose !== KeyPurpose.AUTHENTICATION) {
    return {
      ...base,
      error: `This key cannot be used for authentication (it's a ${getPurposeName(match.purpose)} key)`,
      errorType: 'WRONG_PURPOSE',
    }
  }
  return {
    ...base,
    // MASTER is more powerful than CRITICAL/HIGH but must never be used to sign in; MEDIUM and lower are too weak.
    error: match.securityLevel === SecurityLevel.MASTER
      ? 'This is your MASTER key - keep it safe! Use a HIGH or CRITICAL authentication key instead.'
      : `This key's security level is too low (${getSecurityLevelName(match.securityLevel)}) - need HIGH or CRITICAL`,
    errorType: 'WRONG_SECURITY_LEVEL',
  }
}

/** A key that isn't a WIF, or is one for another network: refused before any identity is read. */
export function checkLoginKeyFormat(privateKeyWif: string, network: 'testnet' | 'mainnet'): LoginKeyResult | null {
  try {
    if (validateWifNetwork(wifToPrivateKey(privateKeyWif).prefix, network)) return null
    return { isValid: false, error: 'This key is for a different network', errorType: 'NETWORK_MISMATCH' }
  } catch {
    return { isValid: false, error: 'Invalid private key format', errorType: 'INVALID_WIF' }
  }
}

/**
 * Whether a typed-in private key may sign `publicKeys`' identity in. It must
 * be one of the identity's enabled CRITICAL or HIGH authentication keys, the
 * same rule session restore and signing apply (matchIdentityKey), so a key
 * the identity has disabled is refused here rather than after sign-in.
 */
export function checkLoginKey(
  privateKeyWif: string,
  publicKeys: readonly IdentityKeyLike[],
  network: 'testnet' | 'mainnet',
): LoginKeyResult {
  const malformed = checkLoginKeyFormat(privateKeyWif, network)
  if (malformed) return malformed

  const result = matchIdentityKey(privateKeyWif, publicKeys, {
    network,
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: LOGIN_LEVELS,
  })
  if (result.ok) return { isValid: true, ...keyFacts(result.match) }
  if (result.reason === 'rejected' || result.reason === 'wrong-key-id') return rejection(result.match)

  const disabled = publicKeys
    .filter((key) => key.disabledAt)
    .map(toKeyInfo)
    .filter((info): info is IdentityPublicKeyInfo => info !== null)
  const disabledMatch = findMatchingKeyIndex(privateKeyWif, disabled, network)
  if (disabledMatch) {
    return {
      isValid: false,
      ...keyFacts(disabledMatch),
      error: 'This key has been disabled on this identity. Use another key.',
      errorType: 'DISABLED',
    }
  }
  return { isValid: false, error: 'This key does not match this identity', errorType: 'NO_MATCH' }
}
