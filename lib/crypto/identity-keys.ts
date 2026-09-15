/**
 * Identity public-key enums as Dash Platform numbers them, plus the helpers
 * that name them for logs and error messages. Every comparison against a raw
 * `0`/`1`/`2` in the codebase should go through these.
 */

export const KeyPurpose = {
  AUTHENTICATION: 0,
  ENCRYPTION: 1,
  DECRYPTION: 2,
  TRANSFER: 3,
  SYSTEM: 4,
  VOTING: 5,
  OWNER: 6,
} as const

export const SecurityLevel = {
  MASTER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
} as const

export const KeyType = {
  ECDSA_SECP256K1: 0,
  BLS12_381: 1,
  ECDSA_HASH160: 2,
  BIP13_SCRIPT_HASH: 3,
  EDDSA_25519_HASH160: 4,
} as const

const SECURITY_LEVEL_NAMES: Record<number, string> = {
  [SecurityLevel.MASTER]: 'MASTER',
  [SecurityLevel.CRITICAL]: 'CRITICAL',
  [SecurityLevel.HIGH]: 'HIGH',
  [SecurityLevel.MEDIUM]: 'MEDIUM',
}

const PURPOSE_NAMES: Record<number, string> = {
  [KeyPurpose.AUTHENTICATION]: 'AUTHENTICATION',
  [KeyPurpose.ENCRYPTION]: 'ENCRYPTION',
  [KeyPurpose.DECRYPTION]: 'DECRYPTION',
  [KeyPurpose.TRANSFER]: 'TRANSFER',
  [KeyPurpose.SYSTEM]: 'SYSTEM',
  [KeyPurpose.VOTING]: 'VOTING',
  [KeyPurpose.OWNER]: 'OWNER',
}

function invert(names: Record<number, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(names).map(([value, name]) => [name.toLowerCase(), Number(value)]))
}

const PURPOSE_BY_NAME = invert(PURPOSE_NAMES)
const SECURITY_LEVEL_BY_NAME = invert(SECURITY_LEVEL_NAMES)
const KEY_TYPE_BY_NAME: Record<string, number> = {
  ecdsa_secp256k1: KeyType.ECDSA_SECP256K1,
  ecdsa: KeyType.ECDSA_SECP256K1,
  bls12_381: KeyType.BLS12_381,
  ecdsa_hash160: KeyType.ECDSA_HASH160,
  bip13_script_hash: KeyType.BIP13_SCRIPT_HASH,
  eddsa_25519_hash160: KeyType.EDDSA_25519_HASH160,
}

/**
 * Resolve an enum value that may arrive as a number, a bigint, a numeric
 * string, or the lowercase name the wasm getters return. `null` when it is
 * none of those, so callers never mistake "unknown" for value 0.
 */
function resolveEnum(value: unknown, byName: Record<string, number>): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isSafeInteger(asNumber) ? asNumber : null
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (value.trim() !== '' && Number.isInteger(numeric)) return numeric
    return byName[value.toLowerCase()] ?? null
  }
  return null
}

export const resolveKeyPurpose = (value: unknown): number | null => resolveEnum(value, PURPOSE_BY_NAME)
export const resolveSecurityLevel = (value: unknown): number | null => resolveEnum(value, SECURITY_LEVEL_BY_NAME)
export const resolveKeyType = (value: unknown): number | null => resolveEnum(value, KEY_TYPE_BY_NAME)

export function getSecurityLevelName(level: number): string {
  return SECURITY_LEVEL_NAMES[level] ?? `UNKNOWN(${level})`
}

export function getPurposeName(purpose: number): string {
  return PURPOSE_NAMES[purpose] ?? `UNKNOWN(${purpose})`
}

/** App document signing accepts MEDIUM and the existing stronger non-MASTER keys. */
export const DOCUMENT_AUTH_SECURITY_LEVELS: readonly number[] = [
  SecurityLevel.CRITICAL,
  SecurityLevel.HIGH,
  SecurityLevel.MEDIUM,
]

/** DPNS and explicit token operations have their own, stricter requirements. */
export function isSecurityLevelAllowedForLogin(level: number): boolean {
  return DOCUMENT_AUTH_SECURITY_LEVELS.includes(level)
}

export function isPurposeAllowedForLogin(purpose: number): boolean {
  return purpose === KeyPurpose.AUTHENTICATION
}
