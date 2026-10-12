/**
 * Shared encryption key lookup helper.
 *
 * Legacy builds: the active encryption key (purpose=1) on an identity,
 * preferring a full secp256k1 public key (type=0) because callers consume the
 * on-chain key material directly for ECIES/private-feed flows. Contract
 * bounds are ignored there.
 *
 * App Connect builds: only the ENCRYPTION key bound to the `yappr-app` anchor
 * counts, and nothing else stands in for it (a DashPay-bound key is not
 * Yappr's). The authoritative lookup is `identities.contractKeys(id, APP_ID,
 * [ENCRYPTION])`, which returns the identity's current key for the anchor
 * (`resolveEncryptionPublicKey`). The synchronous `findEncryptionKey` reads
 * the same rule off an identity's key list, taking the newest anchor key, for
 * the "does this identity have one" checks that have no network round trip.
 */

import { normalizeBytes } from '@/lib/bytes'
import { isAppConnectBuild, appConnectPins } from '@/lib/app-connect/config'
import { KeyPurpose, KeyType } from './identity-keys'

/** Minimal public key shape accepted by the helper (compatible with identity-service.ts & auth-context.tsx). */
export interface EncryptionKeyCandidate {
  id: number
  type: number
  purpose: number
  disabledAt?: number
  contractBounds?: unknown
  data?: string | Uint8Array
}

/** Whether `bounds` (an identity key's contractBounds, in JSON or object form) is `singleContract(contractId)`. */
export function isBoundToContract(bounds: unknown, contractId: string): boolean {
  if (!bounds || typeof bounds !== 'object') return false
  // A wasm ContractBounds object serializes to the JSON shape.
  const toJSON = (bounds as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') return isBoundToContract(toJSON.call(bounds), contractId)
  const record = bounds as { $type?: unknown; type?: unknown; id?: unknown; contractId?: unknown }
  const kind = record.$type ?? record.type
  const id = record.id ?? record.contractId
  return kind === 'singleContract' && typeof id === 'string' && id === contractId
}

/**
 * The anchor-bound encryption key among `publicKeys`: enabled, secp256k1,
 * bound to `appId`; the newest (highest id) when there are several, which is
 * the one Platform's latest pointer names.
 */
export function findAnchorEncryptionKey<T extends EncryptionKeyCandidate>(publicKeys: T[], appId: string): T | undefined {
  return publicKeys
    .filter((key) => key.purpose === KeyPurpose.ENCRYPTION
      && key.type === KeyType.ECDSA_SECP256K1
      && !key.disabledAt
      && isBoundToContract(key.contractBounds, appId))
    .sort((a, b) => b.id - a.id)[0]
}

function findLegacyEncryptionKey<T extends EncryptionKeyCandidate>(publicKeys: T[]): T | undefined {
  let fallbackKey: T | undefined
  for (const key of publicKeys) {
    if (key.purpose !== KeyPurpose.ENCRYPTION || key.disabledAt) continue
    if (key.type === KeyType.ECDSA_SECP256K1) {
      return key
    }
    if (!fallbackKey) {
      fallbackKey = key
    }
  }
  return fallbackKey
}

/**
 * Find the preferred active encryption key from a list of identity public keys.
 */
export function findEncryptionKey<T extends EncryptionKeyCandidate>(
  publicKeys: T[]
): T | undefined {
  if (isAppConnectBuild()) {
    const pins = appConnectPins()
    return pins ? findAnchorEncryptionKey(publicKeys, pins.appId) : undefined
  }
  return findLegacyEncryptionKey(publicKeys)
}

/**
 * Check whether the identity has at least one active encryption key.
 */
export function hasEncryptionKeyOnIdentity(publicKeys: EncryptionKeyCandidate[]): boolean {
  return findEncryptionKey(publicKeys) !== undefined
}

/**
 * The 33-byte public encryption key to encrypt to `identityId`, or null when
 * it has none. On App Connect builds this asks Platform for the identity's
 * current anchor key (`contractKeys`); `publicKeys` is only read on legacy
 * builds. Throws when the read fails.
 */
export async function resolveEncryptionPublicKey(
  identityId: string,
  publicKeys: () => Promise<EncryptionKeyCandidate[] | null>,
): Promise<Uint8Array | null> {
  let key: EncryptionKeyCandidate | undefined
  if (isAppConnectBuild()) {
    const pins = appConnectPins()
    if (!pins) return null
    const { appConnectPlatformPort } = await import('@/lib/app-connect/platform-port')
    const current = await appConnectPlatformPort.contractKeys(identityId, pins.appId, KeyPurpose.ENCRYPTION)
    key = findAnchorEncryptionKey(current.map((entry) => ({
      id: entry.id,
      type: entry.type,
      purpose: entry.purpose,
      ...(entry.disabledAt !== undefined ? { disabledAt: entry.disabledAt } : {}),
      contractBounds: entry.bounds?.kind === 'singleContract' ? { $type: 'singleContract', id: entry.bounds.contractId } : undefined,
      data: entry.data,
    })), pins.appId)
  } else {
    const keys = await publicKeys()
    key = keys ? findLegacyEncryptionKey(keys) : undefined
  }
  if (!key || key.type !== KeyType.ECDSA_SECP256K1) return null
  const bytes = normalizeBytes(key.data)
  return bytes?.length === 33 ? bytes : null
}
