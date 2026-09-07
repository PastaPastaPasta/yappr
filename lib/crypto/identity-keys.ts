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

export function getSecurityLevelName(level: number): string {
  return SECURITY_LEVEL_NAMES[level] ?? `UNKNOWN(${level})`
}

export function getPurposeName(purpose: number): string {
  return PURPOSE_NAMES[purpose] ?? `UNKNOWN(${purpose})`
}

/** Login and DPNS signing accept CRITICAL or HIGH authentication keys, never MASTER. */
export function isSecurityLevelAllowedForLogin(level: number): boolean {
  return level === SecurityLevel.CRITICAL || level === SecurityLevel.HIGH
}

export function isPurposeAllowedForLogin(purpose: number): boolean {
  return purpose === KeyPurpose.AUTHENTICATION
}
