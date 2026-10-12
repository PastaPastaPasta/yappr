/**
 * Platform identity-key vocabulary shared by the App Connect modules. Numbers
 * match Platform's encodings (`Purpose`, `SecurityLevel`, `KeyType`), so keys
 * read through the SDK can be passed through without translation.
 */

export const KeyPurpose = {
  AUTHENTICATION: 0,
  ENCRYPTION: 1,
  DECRYPTION: 2,
  TRANSFER: 3,
} as const

export const KeySecurityLevel = {
  MASTER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
} as const

export const KeyType = {
  ECDSA_SECP256K1: 0,
  ECDSA_HASH160: 2,
} as const

/** `contractBounds` of an identity key; ids are base58. */
export type AppConnectKeyBounds =
  | { kind: 'singleContract'; contractId: string }
  | { kind: 'documentType'; contractId: string; documentTypeName: string }
  | { kind: 'contractGroup'; groupId: string }

/** An identity public key as the verifier needs it (V0 or V1). */
export interface AppConnectIdentityKey {
  id: number
  type: number
  purpose: number
  securityLevel: number
  /** 33-byte compressed point (ECDSA_SECP256K1) or 20-byte hash160 (ECDSA_HASH160). */
  data: Uint8Array
  disabledAt?: number
  bounds?: AppConnectKeyBounds
  /** V1 limit: lifetime credit budget. */
  totalBudget?: bigint
  /** V1 limit: block time (ms) from which the key can no longer sign. */
  expiresAt?: number
}

/** One member of a contract group; ids are base58. */
export type AppConnectGroupMember =
  | { kind: 'contract'; contractId: string }
  | { kind: 'documentType'; contractId: string; documentTypeName: string }
  | { kind: 'token'; contractId: string; position: number }

/** A group whose members are pinned in the app's config (and checked against chain before use). */
export interface PinnedGroup {
  groupId: string
  members: AppConnectGroupMember[]
}

export interface AppConnectGroupInfo {
  ownerId: string
  adminIds: string[]
  members: AppConnectGroupMember[]
}

/**
 * Reads the app needs to verify a grant. Every read should be proved, and
 * `getIdentityFresh` must bypass any identity cache: a key added moments ago is
 * exactly what is being checked.
 */
export interface AppConnectIdentityPort {
  getIdentityFresh(identityId: string): Promise<{ id: string; publicKeys: AppConnectIdentityKey[] } | null>
  /** Remaining credits per key id; a key without a budget is absent or undefined. */
  remainingBudgets(identityId: string, keyIds: number[]): Promise<Map<number, bigint | undefined>>
  /** The keys Platform currently resolves for `contractId` and `purpose` (`identities.contractKeys`). */
  contractKeys(identityId: string, contractId: string, purpose: number): Promise<AppConnectIdentityKey[]>
  /** The whole group (the port pages the members), or null when it does not exist. */
  groupInfo(groupId: string): Promise<AppConnectGroupInfo | null>
}

export function boundsEqual(a: AppConnectKeyBounds, b: AppConnectKeyBounds): boolean {
  switch (a.kind) {
    case 'singleContract':
      return b.kind === 'singleContract' && a.contractId === b.contractId
    case 'documentType':
      return b.kind === 'documentType' && a.contractId === b.contractId && a.documentTypeName === b.documentTypeName
    case 'contractGroup':
      return b.kind === 'contractGroup' && a.groupId === b.groupId
  }
}
