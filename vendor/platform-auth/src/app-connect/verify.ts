import bs58 from 'bs58'
import { clearSensitiveBytes, decodeYapprIdentityId, getYapprPublicKey, hash160 } from '../key-exchange/yappr-protocol'
import { AppConnectPayloadError, openAppConnectPayload } from './crypto'
import type { AppConnectCandidate } from './poller'
import { authBindingBounds, encBindingBounds, type AppConnectAuthBinding, type AppConnectRequest } from './request'
import {
  KeyPurpose,
  KeySecurityLevel,
  KeyType,
  boundsEqual,
  type AppConnectIdentityKey,
  type AppConnectIdentityPort,
} from './types'

/** A granted key must stay valid this long past `now` to be accepted. */
export const APP_CONNECT_EXPIRY_MARGIN_MS = 60 * 60_000

export type AppConnectRejectReason =
  /** The request named an identity and the candidate is someone else. */
  | 'hint-mismatch'
  | 'framing'
  /** Wrong request, wrong owner (a copied response) or tampered ciphertext. */
  | 'decrypt'
  | 'invalid-key'
  | 'identity-not-found'
  /** A slot's key is not on the candidate identity (yet). */
  | 'key-not-found'
  | 'key-disabled'
  | 'key-master'
  | 'key-purpose'
  | 'key-type'
  | 'key-unbound'
  /** Bound to something the request did not ask for (foreign contract, wrong group or document type). */
  | 'key-unmatched'
  | 'key-level'
  /** Missing the budget or expiry the request asked for, or the group key's mandatory budget. */
  | 'key-limits'
  | 'key-expired'
  | 'budget-exhausted'
  /** Platform returned no remaining budget for a budgeted key (a lagging read). */
  | 'budget-unknown'
  | 'encryption-key-not-current'
  | 'duplicate-binding'
  | 'primary-missing'

export type AppConnectKeyRole = 'singleContract' | 'documentType' | 'contractGroup' | 'encryption' | 'decryption'

export interface AppConnectGrantedKey {
  role: AppConnectKeyRole
  /** Position of the matching binding in `authBindings` or `encBindings`. */
  bindingIndex: number
  privateKey: Uint8Array
  key: AppConnectIdentityKey
  remainingBudget?: bigint
}

export interface AppConnectGrant {
  identityId: string
  authKeys: AppConnectGrantedKey[]
  encryptionKeys: AppConnectGrantedKey[]
}

export type AppConnectVerification =
  | { ok: true; grant: AppConnectGrant }
  /** `retryable`: the identity read may lag the wallet's update; check again shortly. */
  | { ok: false; reason: AppConnectRejectReason; retryable: boolean; slot?: number }

export interface VerifyAppConnectCandidateInput {
  request: AppConnectRequest
  appEphemeralPrivateKey: Uint8Array
  candidate: AppConnectCandidate
  identity: AppConnectIdentityPort
  /** Latest block time (ms), or the wall clock when that is unavailable. */
  now: number
  expiryMarginMs?: number
}

class Rejection {
  constructor(readonly reason: AppConnectRejectReason, readonly slot?: number) {}
}

const RETRYABLE: ReadonlySet<AppConnectRejectReason> = new Set([
  'identity-not-found',
  'key-not-found',
  'budget-unknown',
  'encryption-key-not-current',
])

interface SlotMatch {
  slot: number
  privateKey: Uint8Array
  key: AppConnectIdentityKey
  role: AppConnectKeyRole
  bindingIndex: number
}

/**
 * Verifies one `loginKeyResponse` candidate against the request it answers.
 * Accepts only if every slot is a live key on the candidate's `$ownerId` that
 * matches one requested binding exactly (bounds, purpose, level, limits), the
 * primary binding is granted, no key is about to expire or out of budget, and
 * each encryption key is the one Platform currently resolves for its contract.
 * Anything else rejects the whole candidate; there is no partial accept of a
 * response that contains a key the app did not ask for.
 *
 * `ok: true` means a valid grant from `grant.identityId`, not that this is the
 * user: anyone can answer a request with their own identity. Without an
 * identity hint the app must still ask "Continue as @name?".
 */
export async function verifyAppConnectCandidate(input: VerifyAppConnectCandidateInput): Promise<AppConnectVerification> {
  const { request, candidate } = input
  if (request.identityHint && candidate.ownerId !== bs58.encode(request.identityHint)) {
    return reject(new Rejection('hint-mismatch'))
  }

  let ownerIdBytes: Uint8Array
  try {
    ownerIdBytes = decodeYapprIdentityId(candidate.ownerId)
  } catch {
    return reject(new Rejection('identity-not-found'))
  }

  let slots: Uint8Array[]
  try {
    slots = await openAppConnectPayload({
      appEphemeralPrivateKey: input.appEphemeralPrivateKey,
      ownerId: ownerIdBytes,
      walletEphemeralPubKey: candidate.walletEphemeralPubKey,
      encryptedPayload: candidate.encryptedPayload,
    })
  } catch (error) {
    return reject(new Rejection(error instanceof AppConnectPayloadError ? error.code : 'decrypt'))
  }

  return verifyKeys({ ...input, ownerId: candidate.ownerId }, slots)
}

/** What a grant is checked against, whether its keys came from a wallet's answer or were kept from one. */
interface VerifyContext {
  request: Pick<AppConnectRequest, 'authBindings' | 'encBindings'>
  ownerId: string
  identity: AppConnectIdentityPort
  now: number
  expiryMarginMs?: number
}

export interface VerifyAppConnectKeysInput extends VerifyContext {
  /** The private keys of one earlier grant, in any order; wiped when they are refused. */
  privateKeys: Uint8Array[]
}

/**
 * Verifies private keys an app kept from an earlier grant (Yappr's passkey
 * vault) exactly as {@link verifyAppConnectCandidate} verifies a wallet's
 * answer, against the request the app makes today: every key must still be
 * a live key of `ownerId` that matches one binding (bounds, purpose, level,
 * limits), the primary binding must be there, and nothing may be expired,
 * spent or superseded. A refusal says why, so an expired or spent grant can
 * lead to a renewal in the wallet rather than a dead session.
 */
export function verifyAppConnectKeys(input: VerifyAppConnectKeysInput): Promise<AppConnectVerification> {
  return verifyKeys(input, input.privateKeys)
}

async function verifyKeys(context: VerifyContext, slots: Uint8Array[]): Promise<AppConnectVerification> {
  try {
    if (slots.length > context.request.authBindings.length + context.request.encBindings.length) {
      throw new Rejection('framing')
    }
    const grant = await verifySlots(context, slots)
    return { ok: true, grant }
  } catch (error) {
    slots.forEach(clearSensitiveBytes)
    if (error instanceof Rejection) return reject(error)
    throw error
  }
}

function reject(rejection: Rejection): AppConnectVerification {
  return { ok: false, reason: rejection.reason, retryable: RETRYABLE.has(rejection.reason), slot: rejection.slot }
}

async function verifySlots(input: VerifyContext, slots: Uint8Array[]): Promise<AppConnectGrant> {
  const { request, ownerId, identity, now } = input
  const margin = input.expiryMarginMs ?? APP_CONNECT_EXPIRY_MARGIN_MS

  const record = await identity.getIdentityFresh(ownerId)
  if (!record || record.id !== ownerId) throw new Rejection('identity-not-found')

  const matches: SlotMatch[] = []
  for (const [slot, privateKey] of slots.entries()) {
    const key = findKeyForSlot(record.publicKeys, privateKey, slot)
    const match = matchBinding(request, key, slot)
    checkKeyLimits(key, match, request, now, margin, slot)
    if (matches.some((m) => m.key.id === key.id || (m.role === match.role && m.bindingIndex === match.bindingIndex))) {
      throw new Rejection('duplicate-binding', slot)
    }
    matches.push({ slot, privateKey, key, ...match })
  }

  if (!matches.some((m) => isAuthRole(m.role) && m.bindingIndex === 0)) {
    throw new Rejection('primary-missing')
  }

  for (const match of matches.filter((m) => !isAuthRole(m.role))) {
    const binding = request.encBindings[match.bindingIndex]
    const current = await identity.contractKeys(ownerId, bs58.encode(binding.contractId), binding.purpose)
    if (!current.some((key) => key.id === match.key.id && bytesEqual(key.data, match.key.data))) {
      throw new Rejection('encryption-key-not-current', match.slot)
    }
  }

  const budgeted = matches.filter((m) => m.key.totalBudget !== undefined)
  const remaining = budgeted.length > 0
    ? await identity.remainingBudgets(ownerId, budgeted.map((m) => m.key.id))
    : new Map<number, bigint | undefined>()
  for (const match of budgeted) {
    const left = remaining.get(match.key.id)
    if (left === undefined) throw new Rejection('budget-unknown', match.slot)
    if (left <= 0n) throw new Rejection('budget-exhausted', match.slot)
  }

  const granted = matches.map((m): AppConnectGrantedKey => ({
    role: m.role,
    bindingIndex: m.bindingIndex,
    privateKey: m.privateKey,
    key: m.key,
    remainingBudget: remaining.get(m.key.id),
  }))
  return {
    identityId: ownerId,
    authKeys: granted.filter((g) => isAuthRole(g.role)),
    encryptionKeys: granted.filter((g) => !isAuthRole(g.role)),
  }
}

function isAuthRole(role: AppConnectKeyRole): boolean {
  return role !== 'encryption' && role !== 'decryption'
}

function findKeyForSlot(keys: AppConnectIdentityKey[], privateKey: Uint8Array, slot: number): AppConnectIdentityKey {
  let publicKey: Uint8Array
  try {
    publicKey = getYapprPublicKey(privateKey)
  } catch {
    throw new Rejection('invalid-key', slot)
  }
  const publicKeyHash = hash160(publicKey)
  const found = keys.filter((key) =>
    (key.type === KeyType.ECDSA_SECP256K1 && bytesEqual(key.data, publicKey))
    || (key.type === KeyType.ECDSA_HASH160 && bytesEqual(key.data, publicKeyHash)))
  if (found.length === 0) throw new Rejection('key-not-found', slot)
  if (found.length > 1) throw new Rejection('duplicate-binding', slot)
  return found[0]
}

function matchBinding(
  request: Pick<AppConnectRequest, 'authBindings' | 'encBindings'>,
  key: AppConnectIdentityKey,
  slot: number,
): { role: AppConnectKeyRole; bindingIndex: number } {
  if (key.disabledAt !== undefined) throw new Rejection('key-disabled', slot)
  if (key.securityLevel === KeySecurityLevel.MASTER) throw new Rejection('key-master', slot)

  const isAuth = key.purpose === KeyPurpose.AUTHENTICATION
  if (!isAuth && key.purpose !== KeyPurpose.ENCRYPTION && key.purpose !== KeyPurpose.DECRYPTION) {
    throw new Rejection('key-purpose', slot)
  }
  if (!key.bounds) throw new Rejection('key-unbound', slot)
  const bounds = key.bounds

  if (isAuth) {
    const bindingIndex = request.authBindings.findIndex((binding) => boundsEqual(authBindingBounds(binding), bounds))
    if (bindingIndex === -1) throw new Rejection('key-unmatched', slot)
    const binding = request.authBindings[bindingIndex]
    if (!authLevelAllowed(binding, key.securityLevel)) throw new Rejection('key-level', slot)
    if (key.type !== KeyType.ECDSA_SECP256K1 && key.type !== KeyType.ECDSA_HASH160) {
      throw new Rejection('key-type', slot)
    }
    return { role: binding.kind, bindingIndex }
  }

  const bindingIndex = request.encBindings.findIndex((binding) =>
    binding.purpose === key.purpose && boundsEqual(encBindingBounds(binding), bounds))
  if (bindingIndex === -1) throw new Rejection('key-unmatched', slot)
  if (key.securityLevel !== KeySecurityLevel.MEDIUM) throw new Rejection('key-level', slot)
  // Peers need the full point for ECDH, so a hash-only key is useless here.
  if (key.type !== KeyType.ECDSA_SECP256K1) throw new Rejection('key-type', slot)
  return { role: key.purpose === KeyPurpose.ENCRYPTION ? 'encryption' : 'decryption', bindingIndex }
}

/**
 * A group key may be CRITICAL or HIGH and never more privileged than asked;
 * everything else is exactly HIGH. (Lower numbers are more privileged.)
 */
function authLevelAllowed(binding: AppConnectAuthBinding, level: number): boolean {
  if (binding.kind === 'contractGroup') {
    return (level === KeySecurityLevel.CRITICAL || level === KeySecurityLevel.HIGH) && level >= binding.securityLevel
  }
  return level === KeySecurityLevel.HIGH
}

function checkKeyLimits(
  key: AppConnectIdentityKey,
  match: { role: AppConnectKeyRole; bindingIndex: number },
  request: Pick<AppConnectRequest, 'authBindings' | 'encBindings'>,
  now: number,
  margin: number,
  slot: number,
): void {
  if (isAuthRole(match.role)) {
    const binding = request.authBindings[match.bindingIndex]
    // The wallet may change the values (clamps, presets) but never drop a limit.
    const budgetRequired = binding.kind === 'contractGroup' || binding.totalBudget !== undefined
    if (budgetRequired && (key.totalBudget === undefined || key.totalBudget <= 0n)) {
      throw new Rejection('key-limits', slot)
    }
    if (binding.expiresAt !== undefined && key.expiresAt === undefined) throw new Rejection('key-limits', slot)
  }
  if (key.expiresAt !== undefined && key.expiresAt - now <= margin) throw new Rejection('key-expired', slot)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
