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
    return { ...base, error: 'This key can\'t be used to sign in. Use a sign-in key for this account.', errorType: 'WRONG_PURPOSE' }
  }
  return {
    ...base,
    // MASTER is more powerful than CRITICAL/HIGH but must never be used to sign in; MEDIUM and lower are too weak.
    error: match.securityLevel === SecurityLevel.MASTER
      ? 'This is your account\'s master key. Keep it safe, and sign in with a different key.'
      : 'This key\'s security level is too low to sign in. Use a high or critical key.',
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

  // A disabled sign-in key is named as such, even when the same key is also enabled under another purpose or level.
  const disabledSignInKeys = publicKeys
    .filter((key) => key.disabledAt)
    .map(toKeyInfo)
    .filter((info): info is IdentityPublicKeyInfo => info !== null
      && info.purpose === KeyPurpose.AUTHENTICATION && LOGIN_LEVELS.some((level) => level === info.securityLevel))
  const disabledMatch = findMatchingKeyIndex(privateKeyWif, disabledSignInKeys, network)
  if (disabledMatch) {
    return {
      isValid: false,
      ...keyFacts(disabledMatch),
      error: 'This key has been turned off for this account. Use another key.',
      errorType: 'DISABLED',
    }
  }
  if (result.reason === 'rejected') return rejection(result.match)
  return { isValid: false, error: 'This key does not match this identity', errorType: 'NO_MATCH' }
}
