/**
 * Shared encryption key lookup helper.
 *
 * Finds the first active encryption key (purpose=1) on an identity.
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
 * Find the first active encryption key from a list of identity public keys.
 *
 * Accepts any key with purpose=1 that isn't disabled.
 */
export function findEncryptionKey<T extends EncryptionKeyCandidate>(
  publicKeys: T[]
): T | undefined {
  for (const key of publicKeys) {
    if (key.purpose !== 1 || key.disabledAt) continue
    return key
  }
  return undefined
}

/**
 * Check whether the identity has at least one active encryption key.
 */
export function hasEncryptionKeyOnIdentity(publicKeys: EncryptionKeyCandidate[]): boolean {
  return findEncryptionKey(publicKeys) !== undefined
}
