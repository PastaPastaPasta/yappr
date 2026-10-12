import type { AppConnectIdentityKey, AppConnectKeyBounds } from 'platform-auth'
import { normalizeBytes } from '@/lib/bytes'

/**
 * The fields of a wasm `IdentityPublicKey` the App Connect code reads, as a
 * structural type so the mapping can be tested without the wasm module.
 */
export interface WasmIdentityKeyLike {
  keyId: number
  keyTypeNumber: number
  purposeNumber: number
  securityLevelNumber: number
  /** Hex (the wasm getter) or bytes. */
  data: unknown
  disabledAt?: bigint | number | null
  totalBudget?: bigint | null
  expiresAt?: bigint | number | null
  contractBounds?: { toJSON(): { $type: string; id: string; documentTypeName?: string } } | null
}

function toBounds(bounds: WasmIdentityKeyLike['contractBounds']): AppConnectKeyBounds | undefined | null {
  if (!bounds) return undefined
  const json = bounds.toJSON()
  switch (json.$type) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: json.id }
    case 'documentType':
      return json.documentTypeName ? { kind: 'documentType', contractId: json.id, documentTypeName: json.documentTypeName } : null
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: json.id }
    default:
      return null
  }
}

function toNumber(value: bigint | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'bigint' ? Number(value) : value
}

/**
 * Maps a wasm key to the verifier's shape, or null when it cannot be read
 * faithfully (unknown bounds kind, undecodable data). Callers treat null as a
 * key they must not use: an unreadable bound must never look unbound.
 */
export function toAppConnectIdentityKey(key: WasmIdentityKeyLike): AppConnectIdentityKey | null {
  const data = normalizeBytes(key.data)
  const bounds = toBounds(key.contractBounds)
  if (!data || bounds === null) return null
  return {
    id: key.keyId,
    type: key.keyTypeNumber,
    purpose: key.purposeNumber,
    securityLevel: key.securityLevelNumber,
    data,
    ...(key.disabledAt !== null && key.disabledAt !== undefined ? { disabledAt: toNumber(key.disabledAt) } : {}),
    ...(bounds ? { bounds } : {}),
    ...(key.totalBudget !== null && key.totalBudget !== undefined ? { totalBudget: key.totalBudget } : {}),
    ...(key.expiresAt !== null && key.expiresAt !== undefined ? { expiresAt: toNumber(key.expiresAt) } : {}),
  }
}

/** Maps every key and drops the unreadable ones, which then can neither verify nor sign. */
export function toAppConnectIdentityKeys(keys: readonly WasmIdentityKeyLike[]): AppConnectIdentityKey[] {
  return keys.flatMap((key) => {
    const mapped = toAppConnectIdentityKey(key)
    return mapped ? [mapped] : []
  })
}
