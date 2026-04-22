/**
 * Shared encryption key lookup helper.
 *
 * Finds the active encryption key (purpose=1) on an identity.
 *
 * Prefers full secp256k1 public keys (type=0) because callers consume the
 * on-chain key material directly for ECIES/private-feed flows.
 *
 * NOTE: Contract-bound key preference is disabled due to SDK/tooling bugs.
 * We accept any encryption key regardless of contractBounds.
 */

/** Minimal public key shape accepted by the helper (compatible with identity-service.ts & auth-context.tsx). */
export interface EncryptionKeyCandidate {
  id: number
  type: number
  purpose: number
  disabledAt?: number
  contractBounds?: unknown
  data?: string | Uint8Array
}

/**
 * Find the preferred active encryption key from a list of identity public keys.
 */
export function findEncryptionKey<T extends EncryptionKeyCandidate>(
  publicKeys: T[]
): T | undefined {
  let fallbackKey: T | undefined

  for (const key of publicKeys) {
    if (key.purpose !== 1 || key.disabledAt) continue
    if (key.type === 0) {
      return key
    }
    if (!fallbackKey) {
      fallbackKey = key
    }
  }

  return fallbackKey
}

/**
 * Check whether the identity has at least one active encryption key.
 */
export function hasEncryptionKeyOnIdentity(publicKeys: EncryptionKeyCandidate[]): boolean {
  return findEncryptionKey(publicKeys) !== undefined
}
