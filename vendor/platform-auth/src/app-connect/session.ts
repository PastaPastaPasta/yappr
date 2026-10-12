import type { YapprKeyExchangeNetworkName } from '../core/types'
import type { AppConnectGrant } from './verify'
import { KeySecurityLevel, type AppConnectGroupMember, type AppConnectKeyBounds, type PinnedGroup } from './types'

/**
 * An App Connect session is a key ring, not one key: a group key, a DashPay
 * profile key and an encryption key, each with its own bounds and limits.
 * `selectSigningKey` picks the key for a write before it is built, so a write
 * no key covers never reaches the network (where a bound key outside its
 * bounds is a paid failure, 20014).
 */

export const APP_CONNECT_SESSION_VERSION = 1
/** Keys expiring within this window are not used for new writes. */
export const APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS = 5 * 60_000

export interface AppConnectSessionKey {
  keyId: number
  /** Absent only for a raw-key session's unbound key. */
  bounds?: AppConnectKeyBounds
  securityLevel: number
  totalBudget?: bigint
  /** Last known remaining budget; refreshed after writes and on 40218. */
  remainingBudget?: bigint
  expiresAt?: number
  disabled?: boolean
  /** Opaque handle into the platform's key store; the private key never sits in the session. */
  keyRef: string
}

export interface AppConnectSession {
  v: typeof APP_CONNECT_SESSION_VERSION
  network: YapprKeyExchangeNetworkName
  identityId: string
  appId: string
  groupId: string
  /** Hex, 16 bytes, per device and network; survives logout so re-logins supersede. */
  connectionId: string
  grantedAt: number
  authKeys: AppConnectSessionKey[]
  encKey?: { keyId: number; contractId: string; keyRef: string }
}

export interface BuildAppConnectSessionInput {
  network: YapprKeyExchangeNetworkName
  appId: string
  groupId: string
  connectionId: string
  grantedAt: number
  /** Stores a granted private key and returns its handle. */
  keyRef: (privateKey: Uint8Array, keyId: number) => string
}

export function buildAppConnectSession(grant: AppConnectGrant, input: BuildAppConnectSessionInput): AppConnectSession {
  const authKeys = grant.authKeys.map((granted): AppConnectSessionKey => ({
    keyId: granted.key.id,
    bounds: granted.key.bounds,
    securityLevel: granted.key.securityLevel,
    totalBudget: granted.key.totalBudget,
    remainingBudget: granted.remainingBudget,
    expiresAt: granted.key.expiresAt,
    keyRef: input.keyRef(granted.privateKey, granted.key.id),
  }))
  const encryption = grant.encryptionKeys.find((granted) => granted.role === 'encryption')
  const encBounds = encryption?.key.bounds
  return {
    v: APP_CONNECT_SESSION_VERSION,
    network: input.network,
    identityId: grant.identityId,
    appId: input.appId,
    groupId: input.groupId,
    connectionId: input.connectionId,
    grantedAt: input.grantedAt,
    authKeys,
    encKey: encryption && encBounds?.kind === 'singleContract'
      ? {
          keyId: encryption.key.id,
          contractId: encBounds.contractId,
          keyRef: input.keyRef(encryption.privateKey, encryption.key.id),
        }
      : undefined,
  }
}

/** One member of a batch: a document operation or a token operation. */
export type SigningMember =
  | { contractId: string; documentType: string }
  | { contractId: string; tokenPosition: number }

export interface SigningRequest {
  /** Bound keys sign batches only (20013 otherwise). */
  transition: 'batch' | 'non-batch'
  members: SigningMember[]
  /** Strictest level the members' document types require; HIGH by default. Token members force CRITICAL. */
  requiredSecurityLevel?: number
  /** Expected credit cost; keys whose remaining budget is below it are skipped. */
  estimatedCost?: bigint
}

export interface SelectSigningKeyContext {
  now: number
  groups: PinnedGroup[]
  expiryMarginMs?: number
}

export interface SigningPlanStep {
  key: AppConnectSessionKey
  members: SigningMember[]
}

export type SigningKeySelection =
  | { ok: true; key: AppConnectSessionKey }
  /**
   * `non-batch`: only an unbound key could sign it; hand off to the wallet.
   * `needs-split`: no one key covers every member, but `plan` signs them in
   * separate batches (not atomic; the caller decides whether that is fine).
   * `no-covering-key`: nothing usable covers some member; renew or hand off.
   */
  | { ok: false; reason: 'empty' | 'non-batch' | 'no-covering-key' }
  | { ok: false; reason: 'needs-split'; plan: SigningPlanStep[] }

function isToken(member: SigningMember): member is { contractId: string; tokenPosition: number } {
  return 'tokenPosition' in member
}

/** Whether `bounds` (or no bounds: an unbound key) admits `member`. */
function covers(bounds: AppConnectKeyBounds | undefined, member: SigningMember, groups: PinnedGroup[]): boolean {
  if (!bounds) return true
  switch (bounds.kind) {
    case 'singleContract':
      return member.contractId === bounds.contractId
    case 'documentType':
      // Token operations are contract-wide and never covered by a document-type bound.
      return !isToken(member) && member.contractId === bounds.contractId && member.documentType === bounds.documentTypeName
    case 'contractGroup': {
      const group = groups.find((g) => g.groupId === bounds.groupId)
      return group !== undefined && group.members.some((m) => groupMemberCovers(m, member))
    }
  }
}

function groupMemberCovers(groupMember: AppConnectGroupMember, member: SigningMember): boolean {
  if (groupMember.contractId !== member.contractId) return false
  switch (groupMember.kind) {
    case 'contract':
      return true
    case 'documentType':
      return !isToken(member) && member.documentType === groupMember.documentTypeName
    case 'token':
      return isToken(member) && member.tokenPosition === groupMember.position
  }
}

/** Narrowest first: a documentType key before a contract key before a group key before an unbound key. */
function scopeRank(key: AppConnectSessionKey): number {
  switch (key.bounds?.kind) {
    case 'documentType':
      return 0
    case 'singleContract':
      return 1
    case 'contractGroup':
      return 2
    default:
      return 3
  }
}

function usable(key: AppConnectSessionKey, request: SigningRequest, ctx: SelectSigningKeyContext): boolean {
  if (key.disabled) return false
  if (key.securityLevel === KeySecurityLevel.MASTER) return false
  const margin = ctx.expiryMarginMs ?? APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS
  if (key.expiresAt !== undefined && key.expiresAt - ctx.now <= margin) return false
  if (key.remainingBudget !== undefined && key.remainingBudget < (request.estimatedCost ?? 1n)) return false
  return true
}

/** Lower is more privileged, so the key's level must be numerically at most the requirement. */
function levelSatisfies(key: AppConnectSessionKey, required: number): boolean {
  return key.securityLevel <= required
}

function requiredLevel(request: SigningRequest, members: SigningMember[]): number {
  const base = request.requiredSecurityLevel ?? KeySecurityLevel.HIGH
  // Platform requires CRITICAL for any batch that contains a token transition.
  return members.some(isToken) ? Math.min(base, KeySecurityLevel.CRITICAL) : base
}

/** Narrowest scope, then least privilege, then the most budget left, then the newest key. */
function compareKeys(a: AppConnectSessionKey, b: AppConnectSessionKey): number {
  return scopeRank(a) - scopeRank(b)
    || b.securityLevel - a.securityLevel
    || compareBudget(b.remainingBudget, a.remainingBudget)
    || b.keyId - a.keyId
}

function compareBudget(a: bigint | undefined, b: bigint | undefined): number {
  // No budget means unlimited.
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a > b ? 1 : -1
}

function bestKey(
  keys: AppConnectSessionKey[],
  members: SigningMember[],
  request: SigningRequest,
  ctx: SelectSigningKeyContext,
): AppConnectSessionKey | undefined {
  const level = requiredLevel(request, members)
  return keys
    .filter((key) => usable(key, request, ctx)
      && levelSatisfies(key, level)
      && members.every((member) => covers(key.bounds, member, ctx.groups)))
    .sort(compareKeys)[0]
}

/**
 * Picks the key that signs `request`, or says why none can. Pure: budgets and
 * expiries come from the session, membership from the pinned groups.
 */
export function selectSigningKey(
  keys: AppConnectSessionKey[],
  request: SigningRequest,
  ctx: SelectSigningKeyContext,
): SigningKeySelection {
  if (request.transition === 'non-batch') {
    const unbound = keys.filter((key) => !key.bounds)
    const key = bestKey(unbound, request.members, request, ctx)
    return key ? { ok: true, key } : { ok: false, reason: 'non-batch' }
  }
  if (request.members.length === 0) return { ok: false, reason: 'empty' }

  const key = bestKey(keys, request.members, request, ctx)
  if (key) return { ok: true, key }

  // Mixed batch (for example a DashPay profile plus a Yappr profile): sign
  // each member with its own best key, grouped by key in first-use order.
  const plan: SigningPlanStep[] = []
  for (const member of request.members) {
    const memberKey = bestKey(keys, [member], request, ctx)
    if (!memberKey) return { ok: false, reason: 'no-covering-key' }
    const step = plan.find((s) => s.key.keyId === memberKey.keyId)
    if (step) step.members.push(member)
    else plan.push({ key: memberKey, members: [member] })
  }
  return { ok: false, reason: 'needs-split', plan }
}
