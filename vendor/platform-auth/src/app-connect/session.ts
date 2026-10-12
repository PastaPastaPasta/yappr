import type { YapprKeyExchangeNetworkName } from '../core/types'
import { clearSensitiveBytes } from '../key-exchange/yappr-protocol'
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
  /** Last known remaining budget; refreshed after writes and on 40218. A budgeted key without one is not used. */
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
  /** ENCRYPTION and DECRYPTION keys, one per granted encryption binding. */
  encKeys: AppConnectSessionEncKey[]
}

export interface AppConnectSessionEncKey {
  keyId: number
  contractId: string
  /** ENCRYPTION or DECRYPTION. */
  purpose: number
  keyRef: string
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

/**
 * Turns a verified grant into a session: every private key goes to `keyRef`
 * and is then wiped from the grant, so the grant is spent afterwards.
 */
export function buildAppConnectSession(grant: AppConnectGrant, input: BuildAppConnectSessionInput): AppConnectSession {
  try {
    const authKeys = grant.authKeys.map((granted): AppConnectSessionKey => ({
      keyId: granted.key.id,
      bounds: granted.key.bounds,
      securityLevel: granted.key.securityLevel,
      totalBudget: granted.key.totalBudget,
      remainingBudget: granted.remainingBudget,
      expiresAt: granted.key.expiresAt,
      keyRef: input.keyRef(granted.privateKey, granted.key.id),
    }))
    const encKeys = grant.encryptionKeys.map((granted): AppConnectSessionEncKey => {
      // The verifier only accepts encryption keys bound to a single contract.
      const bounds = granted.key.bounds
      if (bounds?.kind !== 'singleContract') throw new Error('encryption key is not bound to a contract')
      return {
        keyId: granted.key.id,
        contractId: bounds.contractId,
        purpose: granted.key.purpose,
        keyRef: input.keyRef(granted.privateKey, granted.key.id),
      }
    })
    return {
      v: APP_CONNECT_SESSION_VERSION,
      network: input.network,
      identityId: grant.identityId,
      appId: input.appId,
      groupId: input.groupId,
      connectionId: input.connectionId,
      grantedAt: input.grantedAt,
      authKeys,
      encKeys,
    }
  } finally {
    for (const granted of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(granted.privateKey)
  }
}

/**
 * One member of a batch: a document operation or a token operation. Each
 * carries its own requirements, so a batch that has to be split is checked
 * step by step rather than against the whole batch's.
 */
export type SigningMember = DocumentSigningMember | TokenSigningMember

export interface DocumentSigningMember {
  contractId: string
  documentType: string
  /**
   * The type's `securityLevelRequirement` (HIGH unless the type says
   * otherwise). Required, because guessing low costs a paid 20004.
   */
  securityLevel: number
  /** Types this create consumes (`consume`); the key's bounds must cover them too. */
  consumedDocumentTypes?: string[]
  /** Expected credit cost of this member. */
  estimatedCost?: bigint
}

/** Platform requires CRITICAL for any batch with a token transition. */
export interface TokenSigningMember {
  contractId: string
  tokenPosition: number
  estimatedCost?: bigint
}

export type SigningRequest =
  | { transition: 'batch'; members: SigningMember[] }
  /** Bound keys sign batches only (20013 otherwise). */
  | { transition: 'non-batch'; requiredSecurityLevel: number; estimatedCost?: bigint }

export interface SelectSigningKeyContext {
  now: number
  /** Only pins that passed `checkAppConnectGroupTrust`: the selector trusts them as the group's members. */
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
   * separate batches. Not atomic, and members are regrouped by key, so the
   * order across steps can differ from the request's; the caller decides
   * whether that is fine.
   * `no-covering-key`: nothing usable covers some member; renew or hand off.
   */
  | { ok: false; reason: 'empty' | 'non-batch' | 'no-covering-key' }
  | { ok: false; reason: 'needs-split'; plan: SigningPlanStep[] }

function isToken(member: SigningMember): member is TokenSigningMember {
  return 'tokenPosition' in member
}

/** What signing a set of members needs: the strictest level and the summed cost. */
interface Requirement {
  level: number
  cost: bigint
}

function requirementOf(members: SigningMember[]): Requirement {
  return {
    level: Math.min(...members.map((m) => (isToken(m) ? KeySecurityLevel.CRITICAL : m.securityLevel))),
    cost: members.reduce((sum, m) => sum + (m.estimatedCost ?? 0n), 0n),
  }
}

/** Whether `bounds` (or no bounds: an unbound key) admits `member`, including every type it consumes. */
function covers(bounds: AppConnectKeyBounds | undefined, member: SigningMember, groups: PinnedGroup[]): boolean {
  if (isToken(member) || !member.consumedDocumentTypes?.length) return coversOne(bounds, member, groups)
  return [member.documentType, ...member.consumedDocumentTypes]
    .every((documentType) => coversOne(bounds, { contractId: member.contractId, documentType }, groups))
}

function coversOne(
  bounds: AppConnectKeyBounds | undefined,
  member: Pick<DocumentSigningMember, 'contractId' | 'documentType'> | TokenSigningMember,
  groups: PinnedGroup[],
): boolean {
  if (!bounds) return true
  switch (bounds.kind) {
    case 'singleContract':
      return member.contractId === bounds.contractId
    case 'documentType':
      // Token operations are contract-wide and never covered by a document-type bound.
      return !('tokenPosition' in member) && member.contractId === bounds.contractId && member.documentType === bounds.documentTypeName
    case 'contractGroup': {
      const group = groups.find((g) => g.groupId === bounds.groupId)
      return group !== undefined && group.members.some((m) => groupMemberCovers(m, member))
    }
  }
}

function groupMemberCovers(
  groupMember: AppConnectGroupMember,
  member: Pick<DocumentSigningMember, 'contractId' | 'documentType'> | TokenSigningMember,
): boolean {
  if (groupMember.contractId !== member.contractId) return false
  const token = 'tokenPosition' in member
  switch (groupMember.kind) {
    case 'contract':
      return true
    case 'documentType':
      return !token && member.documentType === groupMember.documentTypeName
    case 'token':
      return token && member.tokenPosition === groupMember.position
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

function usable(key: AppConnectSessionKey, requirement: Requirement, ctx: SelectSigningKeyContext): boolean {
  if (key.disabled) return false
  if (key.securityLevel === KeySecurityLevel.MASTER) return false
  const margin = ctx.expiryMarginMs ?? APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS
  if (key.expiresAt !== undefined && key.expiresAt - ctx.now <= margin) return false
  // A budgeted key whose remaining budget is unknown is not unlimited: skip it until refreshed.
  if (key.totalBudget !== undefined && key.remainingBudget === undefined) return false
  if (key.remainingBudget !== undefined
    && (key.remainingBudget <= 0n || key.remainingBudget < requirement.cost)) return false
  // Lower is more privileged, so the key's level must be numerically at most the requirement.
  return key.securityLevel <= requirement.level
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

/** `allocated`: cost already assigned to each key by earlier steps of a split plan. */
function bestKey(
  keys: AppConnectSessionKey[],
  members: SigningMember[],
  requirement: Requirement,
  ctx: SelectSigningKeyContext,
  allocated: ReadonlyMap<number, bigint> = new Map(),
): AppConnectSessionKey | undefined {
  return keys
    .filter((key) => usable(key, { ...requirement, cost: requirement.cost + (allocated.get(key.keyId) ?? 0n) }, ctx)
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
    // Only an unbound authentication key (a raw-key session) can sign these.
    // Session keys carry no purpose, so TRANSFER-purpose transitions are out of scope.
    const unbound = keys.filter((key) => !key.bounds)
    const requirement = { level: request.requiredSecurityLevel, cost: request.estimatedCost ?? 0n }
    const key = bestKey(unbound, [], requirement, ctx)
    return key ? { ok: true, key } : { ok: false, reason: 'non-batch' }
  }
  const { members } = request
  if (members.length === 0) return { ok: false, reason: 'empty' }

  const key = bestKey(keys, members, requirementOf(members), ctx)
  if (key) return { ok: true, key }

  // Mixed batch (for example a DashPay profile plus a Yappr profile): give
  // each member, in order, the most preferred key that covers it at its own
  // level and can still afford it on top of what earlier members took from
  // that key; group the members by key in first-use order. This is greedy, so
  // an exotic allocation can be missed; that ends in `no-covering-key` (a
  // wallet handoff), never in an unaffordable plan.
  const plan: SigningPlanStep[] = []
  const allocated = new Map<number, bigint>()
  for (const member of members) {
    const requirement = requirementOf([member])
    const memberKey = bestKey(keys, [member], requirement, ctx, allocated)
    if (!memberKey) return { ok: false, reason: 'no-covering-key' }
    allocated.set(memberKey.keyId, (allocated.get(memberKey.keyId) ?? 0n) + requirement.cost)
    const step = plan.find((s) => s.key.keyId === memberKey.keyId)
    if (step) step.members.push(member)
    else plan.push({ key: memberKey, members: [member] })
  }
  return { ok: false, reason: 'needs-split', plan }
}
