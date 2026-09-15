import * as secp256k1 from '@noble/secp256k1'
import { hash160 } from './hash'
import { wifToPrivateKey, validateWifNetwork } from './wif'
import { KeyType, resolveKeyPurpose, resolveKeyType, resolveSecurityLevel } from './identity-keys'
import { bytesEqual, normalizeBytes } from '@/lib/bytes'

export interface IdentityPublicKeyInfo {
  id: number
  type: number
  purpose: number
  securityLevel: number
  data: Uint8Array
}

export interface KeyMatchResult {
  keyId: number
  securityLevel: number
  purpose: number
  publicKey: Uint8Array
}

/**
 * The shapes an identity key arrives in. The wasm `IdentityPublicKey` getter
 * object exposes `keyId`/`purposeNumber`/`securityLevelNumber`/`keyTypeNumber`
 * with hex `data`; `identity.toJSON()` and the app's own `IdentityPublicKey`
 * use `id`/`purpose`/`securityLevel`/`type` with base64 or byte `data`.
 */
export interface IdentityKeyLike {
  id?: number
  keyId?: number
  /** Numeric on the app shape; the wasm getter object names it (`keyType: 'ecdsa_secp256k1'`) and carries `keyTypeNumber`. */
  type?: number | string
  keyType?: number | string
  keyTypeNumber?: number
  purpose?: number | string
  purposeNumber?: number
  securityLevel?: number | string
  securityLevelNumber?: number
  disabledAt?: number | bigint | null
  data: unknown
}

/**
 * Normalize either identity-key shape into the numeric fields the matcher
 * reads. `null` when the data or any enum cannot be resolved: a key that
 * cannot be classified must not be mistaken for an AUTHENTICATION/MASTER one.
 */
export function toKeyInfo(key: IdentityKeyLike): IdentityPublicKeyInfo | null {
  const data = normalizeBytes(key.data)
  const id = key.keyId ?? key.id
  const type = resolveKeyType(key.keyTypeNumber ?? key.keyType ?? key.type)
  const purpose = resolveKeyPurpose(key.purposeNumber ?? key.purpose)
  const securityLevel = resolveSecurityLevel(key.securityLevelNumber ?? key.securityLevel)
  if (!data || id === undefined || type === null || purpose === null || securityLevel === null) return null
  return { id, type, purpose, securityLevel, data }
}

/**
 * Get compressed public key from private key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
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
  let privateKey: Uint8Array
  try {
    const decoded = wifToPrivateKey(privateKeyWif)
    privateKey = decoded.privateKey
    if (!validateWifNetwork(decoded.prefix, network)) {
      return null
    }
  } catch {
    return null
  }

  const publicKey = getPublicKey(privateKey)
  const publicKeyHash = hash160(publicKey)

  for (const key of identityPublicKeys) {
    // ECDSA_SECP256K1 keys store the 33-byte compressed point; ECDSA_HASH160
    // keys store its 20-byte hash160.
    const candidate = key.type === KeyType.ECDSA_SECP256K1
      ? publicKey
      : key.type === KeyType.ECDSA_HASH160
        ? publicKeyHash
        : null
    if (candidate && bytesEqual(candidate, key.data)) {
      return { keyId: key.id, securityLevel: key.securityLevel, purpose: key.purpose, publicKey }
    }
  }

  return null
}

export interface MatchIdentityKeyOptions {
  network: 'testnet' | 'mainnet'
  /** Only keys with this purpose are considered. */
  purpose: number
  /**
   * Security levels the caller can sign with; omit to accept any. Filtering
   * happens BEFORE matching so that a lower-security key derived from the
   * same private key (for example a MEDIUM key added after a rotation) cannot
   * win the match and mask the key the operation actually needs.
   */
  allowedSecurityLevels?: readonly number[]
  /** When set, the match must land on exactly this key id. */
  keyId?: number
}

export type MatchIdentityKeyResult<K> =
  | { ok: true; key: K; match: KeyMatchResult }
  /** The WIF matches no enabled key on the identity at all. */
  | { ok: false; reason: 'no-match' }
  /** The WIF matches an enabled key, but not one of the purpose/level asked for. */
  | { ok: false; reason: 'rejected'; match: KeyMatchResult }
  /** The WIF matches an acceptable key, but not the one `keyId` pinned. */
  | { ok: false; reason: 'wrong-key-id'; match: KeyMatchResult }

/**
 * Find the enabled identity key, of the given purpose and at one of the
 * allowed security levels, whose public key the WIF corresponds to. Returns
 * the original key object so callers can hand it straight to the signer.
 */
export function matchIdentityKey<K extends IdentityKeyLike>(
  privateKeyWif: string,
  keys: readonly K[],
  options: MatchIdentityKeyOptions
): MatchIdentityKeyResult<K> {
  const enabled: { key: K; info: IdentityPublicKeyInfo }[] = []
  for (const key of keys) {
    if (key.disabledAt) continue
    const info = toKeyInfo(key)
    if (info) enabled.push({ key, info })
  }
  const acceptable = enabled.filter(
    ({ info }) =>
      info.purpose === options.purpose &&
      (options.allowedSecurityLevels?.includes(info.securityLevel) ?? true)
  )

  const match = findMatchingKeyIndex(privateKeyWif, acceptable.map((c) => c.info), options.network)
  if (!match) {
    // Name the key the WIF does correspond to, so the caller can say why it
    // was turned down rather than only that it was.
    const rejected = findMatchingKeyIndex(privateKeyWif, enabled.map((c) => c.info), options.network)
    return rejected ? { ok: false, reason: 'rejected', match: rejected } : { ok: false, reason: 'no-match' }
  }
  if (options.keyId !== undefined && match.keyId !== options.keyId) {
    return { ok: false, reason: 'wrong-key-id', match }
  }
  const found = acceptable.find((c) => c.info.id === match.keyId)
  if (!found) {
    return { ok: false, reason: 'no-match' }
  }
  return { ok: true, key: found.key, match }
}
