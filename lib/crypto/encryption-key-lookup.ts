/**
 * Shared encryption key lookup helper.
 *
 * Centralizes the logic for finding the "right" encryption key on an identity:
 *   1. Prefer a contract-bound key whose contractBounds.identifier === YAPPR_VAULT_CONTRACT_ID
 *   2. Fall back to the first unbound purpose=1, type=0 key that isn't disabled
 */

import { YAPPR_VAULT_CONTRACT_ID } from '@/lib/constants'

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
 * Find the best encryption key from a list of identity public keys.
 *
 * Resolution order:
 *   1. Contract-bound key for the vault contract (purpose=1, type=0, not disabled)
 *   2. First unbound key (purpose=1, type=0, not disabled)
 */
export function findEncryptionKey<T extends EncryptionKeyCandidate>(
  publicKeys: T[]
): T | undefined {
  const vaultContractId = YAPPR_VAULT_CONTRACT_ID
  const hasVaultContract = vaultContractId && !vaultContractId.includes('PLACEHOLDER')

  let contractBoundKey: T | undefined
  let unboundKey: T | undefined

  for (const key of publicKeys) {
    if (key.purpose !== 1 || key.type !== 0 || key.disabledAt) continue

    if (hasVaultContract && isContractBound(key.contractBounds, vaultContractId)) {
      contractBoundKey = key
      break // Best match — stop searching
    }

    if (!unboundKey && !key.contractBounds) {
      unboundKey = key
    }
  }

  return contractBoundKey ?? unboundKey
}

/**
 * Check whether the identity has at least one active encryption key.
 */
export function hasEncryptionKeyOnIdentity(publicKeys: EncryptionKeyCandidate[]): boolean {
  return findEncryptionKey(publicKeys) !== undefined
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Check if contractBounds points to the given contract ID.
 *
 * `contractBounds` from `identity.toJSON()` is `ContractBoundsJSON` which has
 * an `identifier` field as a **base58 string**.
 */
function isContractBound(bounds: unknown, expectedId: string): boolean {
  if (!bounds || typeof bounds !== 'object') return false
  const identifier = (bounds as Record<string, unknown>).identifier
  // The identifier might be nested inside a SingleContract variant
  if (typeof identifier === 'string') return identifier === expectedId
  // Handle wrapped format: { SingleContract: { id: "..." } }
  const singleContract = (bounds as Record<string, unknown>).SingleContract
  if (singleContract && typeof singleContract === 'object') {
    const id = (singleContract as Record<string, unknown>).id
    if (typeof id === 'string') return id === expectedId
  }
  return false
}
