/**
 * The wallet side of App Connect request v2 (docs/APP_CONNECT_PROFILE.md) for
 * one pool persona: decode the request with the shared codec, apply the
 * profile's wallet rules, register the keys in one MASTER-signed
 * IdentityUpdate, wait for it, then replace the persona's previous
 * `loginKeyResponse` with one sealed by the shared crypto.
 *
 * Platform access goes through {@link AppConnectPorts}, so the whole exchange
 * runs in unit tests against an in-memory chain. Fault flags (faults.ts) bend
 * individual steps for negative tests.
 */
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  AppConnectRequestError,
  appConnectRequestHash,
  authBindingBounds,
  checkAppConnectRequestAge,
  encBindingBounds,
  parseAppConnectUri,
  type AppConnectAuthBinding,
  type AppConnectEncBinding,
  type AppConnectRequest,
} from '../../../../vendor/platform-auth/src/app-connect/request'
import {
  APP_CONNECT_ENVELOPE_BYTES,
  APP_CONNECT_SLOT_BYTES,
  sealAppConnectPayload,
} from '../../../../vendor/platform-auth/src/app-connect/crypto'
import {
  KeyPurpose,
  KeySecurityLevel,
  boundsEqual,
  type AppConnectIdentityKey,
  type AppConnectKeyBounds,
} from '../../../../vendor/platform-auth/src/app-connect/types'
import { getYapprPublicKey } from '../../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import { consensusCode, errorMessage } from '../errors'
import type { Persona } from '../pool'
import { appConnectDerivationTag, type AuthKeySource } from './derive'
import { describeFaults, noFaults, type AppConnectFaults } from './faults'
import type { ConnectionGrant, GrantStore, GrantedAuthKey, StoredRenewal, StoredResponse } from './state'

/** The App Connect system contract (platform docs/protocol/app-connect.md). */
export const APP_CONNECT_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ'
export const LOGIN_KEY_RESPONSE = 'loginKeyResponse'
/** Platform adds at most this many keys per IdentityUpdate (`max_public_keys_in_creation`)… */
const MAX_KEYS_PER_UPDATE = 6
/** …and disables at most this many (`MAX_KEYS_TO_DISABLE`). */
const MAX_DISABLES_PER_UPDATE = 10
/** `DocumentNotFoundError`: an indexOnly delete whose entry is not there. */
const DOCUMENT_NOT_FOUND = 40101

const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
/** Wallet rule 3: the only foreign document type the profile allowlists. */
const ALLOWED_SYSTEM_DOCUMENT_TYPES: ReadonlySet<string> = new Set([`${DASHPAY_CONTRACT_ID}/profile`])

const CREDITS_PER_DASH = 100_000_000_000n
const DAY_MS = 24 * 60 * 60 * 1000
/** Wallet rule 5 caps. */
const BUDGET_CAP = 5n * CREDITS_PER_DASH
const LIFETIME_CAP_MS = 365 * DAY_MS
/** The lifetime preset a key gets when the binding asks for no expiry, so every auth key is V1. */
const DEFAULT_LIFETIME_MS = 90 * DAY_MS
/** `expired`: long enough for the update to land (Platform refuses an already-expired key, 40219). */
const EXPIRED_FAULT_MS = 60_000
/** `wrong-owner` without another persona seals for this id. */
const STRANGER_ID = new Uint8Array(32).fill(0xee)

/** The `ac=` statuses of the profile's callback. */
export type AppConnectStatus = 'ok' | 'declined' | 'stale' | 'unsupported' | 'invalid' | 'failed'

/**
 * A misuse of the responder (a fault flag the request cannot honour, a
 * missing persona): reported as is, not as a wallet outcome with an `ac`.
 */
export class AppConnectUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppConnectUsageError'
  }
}

/** A request the wallet refused or could not complete; `callbackUrl` carries `ac=<status>`. */
export class AppConnectRefusal extends Error {
  callbackUrl?: string

  constructor(readonly status: Exclude<AppConnectStatus, 'ok'>, message: string) {
    super(message)
    this.name = 'AppConnectRefusal'
  }
}

export interface ChainContract {
  ownerId: string
  /** Contract config opt-in to bounded encryption keys; undefined when the contract does not opt in. */
  requiresIdentityEncryptionBoundedKey?: number
  requiresIdentityDecryptionBoundedKey?: number
}

/** A key the wallet adds; always ECDSA_SECP256K1 (it signs its own registration). */
export interface NewIdentityKey {
  privateKey: Uint8Array
  purpose: number
  securityLevel: number
  bounds?: AppConnectKeyBounds
  totalBudget?: bigint
  /** Block time, ms. */
  expiresAt?: number
}

export interface ResponseValues {
  appEphemeralPubKeyHash: Uint8Array
  walletEphemeralPubKey: Uint8Array
  encryptedPayload: Uint8Array
}

export interface AppConnectPorts {
  now(): number
  /** A fresh read of the identity's keys; null when it does not exist. */
  identityKeys(identityId: string): Promise<AppConnectIdentityKey[] | null>
  contract(contractId: string): Promise<ChainContract | null>
  groupOwner(groupId: string): Promise<string | null>
  /** The keys Platform resolves for (identity, contract, purpose): `identities.contractKeys`. */
  contractKeys(identityId: string, contractId: string, purpose: number): Promise<AppConnectIdentityKey[]>
  /** What is left of each key's budget (`identities.keysRemainingBudgets`); undefined for a key without one. */
  remainingBudgets(identityId: string, keyIds: number[]): Promise<Map<number, bigint | undefined>>
  /**
   * One IdentityUpdate signed by the persona's MASTER key. Resolves once the
   * change is visible on chain, with the ids of the added keys in order.
   */
  updateIdentity(persona: Persona, update: { add: NewIdentityKey[]; disable: number[] }): Promise<number[]>
  /** IdentityKeyLimitsUpdate signed by MASTER. */
  raiseKeyLimits(persona: Persona, keyId: number, limits: { addBudget?: bigint; expiresAt?: number }): Promise<void>
  /** Index-only delete carrying all three values, signed by the persona's HIGH key. */
  deleteResponse(persona: Persona, response: StoredResponse): Promise<void>
  /** Signed by the persona's HIGH key. */
  createResponse(persona: Persona, response: ResponseValues): Promise<{ documentId?: string; confirmed: boolean }>
  grants: GrantStore
  log(line: string): void
}

export interface AppConnectInput {
  network?: 'devnet' | 'testnet'
  uri: string
  persona: Persona
  faults?: AppConnectFaults
  /** copy-response, second-identity and wrong-owner act through this persona. */
  otherPersona?: Persona
  /** spam=<n> publishes from the first n of these. */
  spamPersonas?: Persona[]
}

export type AppConnectSlotRole = AppConnectAuthBinding['kind'] | 'encryption' | 'decryption' | 'extra'

export interface AppConnectAnswer {
  personaIdx: number
  identityId: string
  mode: 'login' | 'renew'
  /** Payload order; `keyId` is absent for a key that is on no identity. */
  slots: Array<{ role: AppConnectSlotRole; bindingIndex: number; keyId?: number }>
  addedKeyIds: number[]
  disabledKeyIds: number[]
  raisedKeyIds: number[]
  deletedResponses: number
  documentId?: string
  /** False when the response broadcast went out but its confirmation timed out. */
  confirmed: boolean
}

export interface AppConnectResult {
  kind: 'app-connect'
  appId: string
  appEphemeralPubKeyHash: string
  label: string
  connectionId?: string
  faults: string[]
  /** The request's `cb` with `ac=ok`, for a test to open. */
  callbackUrl?: string
  answer: AppConnectAnswer
  secondIdentity?: AppConnectAnswer
  /** copy-response: the identity that republished the payload. */
  copiedTo?: string
  /** spam: the identities that published junk. */
  spam?: string[]
}

export interface RevokeInput {
  persona: Persona
  appId: string
  /** Hex; without it every connection's grant is revoked. */
  connectionId?: string
}

export interface RevokeResult {
  kind: 'app-connect-revoke'
  personaIdx: number
  identityId: string
  appId: string
  connections: string[]
  disabledKeyIds: number[]
}

interface Plan {
  request: AppConnectRequest
  appId: string
  requestHash: Uint8Array
  derivationTag: Uint8Array
  connectionId?: string
  now: number
  /** Granted bindings with their request positions. */
  auth: Array<{ binding: AppConnectAuthBinding; index: number }>
  enc: Array<{ binding: AppConnectEncBinding; index: number }>
}

/** What a grant record keeps of the request so its keys can be re-derived (hex). */
function recordTags(plan: Plan): Pick<GrantedAuthKey, 'derivationTag' | 'appEphemeralPubKey'> {
  return { derivationTag: bytesToHex(plan.derivationTag), appEphemeralPubKey: bytesToHex(plan.request.appEphemeralPubKey) }
}

interface Slot {
  role: AppConnectSlotRole
  bindingIndex: number
  privateKey: Uint8Array
  keyId?: number
  /** Auth slots: the bounds the key is registered with (what the grant record keeps). */
  bounds?: AppConnectKeyBounds
}

/**
 * True for an App Connect request v2 URI: `dashpay://connect` (scheme and host
 * compared case-insensitively) or the transitional `dash-key:` with `v=2`; v1
 * `dash-key:` belongs to the legacy key exchange.
 */
export function isAppConnectUri(uri: string): boolean {
  if (/^dashpay:\/\/connect(?=[/?#]|$)/i.test(uri)) return true
  if (!uri.startsWith('dash-key:')) return false
  const query = uri.indexOf('?')
  return query !== -1 && new URLSearchParams(uri.slice(query + 1)).getAll('v').includes('2')
}

export async function respondToAppConnect(input: AppConnectInput, ports: AppConnectPorts): Promise<AppConnectResult> {
  const faults = input.faults ?? noFaults()
  const { persona, otherPersona } = input
  if (otherPersona?.identityId === persona.identityId) throw new AppConnectUsageError('the other persona must be a different identity')
  if ((faults.copyResponse || faults.secondIdentity) && !otherPersona) {
    throw new AppConnectUsageError('copy-response and second-identity need another persona (--other-persona / "otherPersona")')
  }
  const spamPersonas = selectSpamPersonas(input, faults.spam ?? 0)

  let callbackUrl: string | undefined
  try {
    const parsed = parseAppConnectUri(input.uri)
    callbackUrl = parsed.callbackUrl
    const served = input.network ?? 'devnet'
    if (parsed.network !== served) {
      throw new AppConnectRefusal('invalid', `Request is for ${parsed.network}; this responder serves ${served}`)
    }
    const { request } = parsed
    const now = ports.now()
    const age = checkAppConnectRequestAge(request.createdAt, now)
    if (age) {
      throw new AppConnectRefusal('stale', age === 'stale' ? 'request is more than 10 minutes old' : 'request is more than 2 minutes in the future')
    }
    if (request.identityHint && bs58.encode(request.identityHint) !== persona.identityId) {
      throw new AppConnectRefusal('invalid', `request names identity ${bs58.encode(request.identityHint)}, not persona ${persona.personaIdx}`)
    }
    await checkRequestAgainstChain(request, now, ports)
    const plan = buildPlan(request, faults, now)

    const spam: string[] = []
    for (const spammer of spamPersonas) {
      // Junk only adds: it must not delete a live response another test lane is polling for.
      await publish(spammer, plan.appId, junkResponse(plan), ports, { replacePrevious: false })
      spam.push(spammer.identityId)
    }

    const main = await answerAs(persona, plan, faults, otherPersona, ports)
    const result: AppConnectResult = {
      kind: 'app-connect',
      appId: plan.appId,
      appEphemeralPubKeyHash: bytesToHex(plan.requestHash),
      label: request.label,
      connectionId: plan.connectionId,
      faults: describeFaults(faults),
      callbackUrl: withStatus(callbackUrl, 'ok'),
      answer: main.answer,
    }
    if (spam.length > 0) result.spam = spam
    if (faults.secondIdentity) result.secondIdentity = (await answerAs(otherPersona!, plan, noFaults(), undefined, ports)).answer
    if (faults.copyResponse) {
      await publish(otherPersona!, plan.appId, main.values, ports)
      result.copiedTo = otherPersona!.identityId
    }
    return result
  } catch (error) {
    if (error instanceof AppConnectUsageError) throw error
    const refusal = toRefusal(error)
    refusal.callbackUrl = withStatus(callbackUrl, refusal.status)
    throw refusal
  }
}

function toRefusal(error: unknown): AppConnectRefusal {
  if (error instanceof AppConnectRefusal) return error
  if (error instanceof AppConnectRequestError) return new AppConnectRefusal(error.code, error.message)
  return new AppConnectRefusal('failed', errorMessage(error))
}

/**
 * Disable-only revoke: MASTER-signed IdentityUpdates disabling the auth keys
 * of the persona's grants for the app (one connection, or all), ten at a time.
 */
export async function revokeAppConnect(input: RevokeInput, ports: AppConnectPorts): Promise<RevokeResult> {
  const { persona, appId } = input
  const record = ports.grants.get(persona.identityId, appId)
  const connections = input.connectionId === undefined ? Object.keys(record.connections) : [input.connectionId]
  if (input.connectionId !== undefined && !record.connections[input.connectionId]) {
    throw new Error(`persona ${persona.personaIdx} has no grant for app ${appId} on connection ${input.connectionId}`)
  }
  const chainKeys = await requireIdentityKeys(persona, ports)
  const disable = [...new Set(liveGrantKeyIds(persona, connections.flatMap((id) => {
    const grant = record.connections[id]
    return [...grant.keys, ...resolvePendingKeys(persona, grant, chainKeys)]
  }), chainKeys))]
  for (let start = 0; start < disable.length; start += MAX_DISABLES_PER_UPDATE) {
    await ports.updateIdentity(persona, { add: [], disable: disable.slice(start, start + MAX_DISABLES_PER_UPDATE) })
  }
  for (const id of connections) delete record.connections[id]
  ports.grants.put(persona.identityId, appId, record)
  return {
    kind: 'app-connect-revoke',
    personaIdx: persona.personaIdx,
    identityId: persona.identityId,
    appId,
    connections,
    disabledKeyIds: disable,
  }
}

/**
 * Wallet rule 7's `ac=` nudge: the callback with the status appended, keeping
 * its query. The responder only reports it; a test opens it if it wants.
 */
function withStatus(callbackUrl: string | undefined, status: AppConnectStatus): string | undefined {
  if (callbackUrl === undefined) return undefined
  const url = new URL(callbackUrl)
  url.searchParams.append('ac', status)
  return url.toString()
}

function selectSpamPersonas(input: AppConnectInput, count: number): Persona[] {
  if (count === 0) return []
  const excluded = new Set([input.persona.identityId, input.otherPersona?.identityId])
  const available = (input.spamPersonas ?? []).filter((candidate) => !excluded.has(candidate.identityId))
  const unique = [...new Map(available.map((candidate) => [candidate.identityId, candidate])).values()]
  if (unique.length < count) {
    throw new Error(`spam=${count} needs ${count} other personas; ${unique.length} available (--spam-personas / "spamPersonas")`)
  }
  return unique.slice(0, count)
}

/** Wallet rules 3 and 5 that need chain reads: owner consistency, encryption opt-in, sane expiries. */
async function checkRequestAgainstChain(request: AppConnectRequest, now: number, ports: AppConnectPorts): Promise<void> {
  const appId = bs58.encode(request.appId)
  const app = await ports.contract(appId)
  if (!app) throw new AppConnectRefusal('invalid', `app id ${appId} is not a contract on this network`)

  for (const binding of request.authBindings) {
    if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
      throw new AppConnectRefusal('invalid', `binding ${binding.kind} asks for an expiry in the past`)
    }
    const id = bs58.encode(binding.id)
    if (binding.kind === 'contractGroup') {
      const groupOwner = await ports.groupOwner(id)
      if (!groupOwner) throw new AppConnectRefusal('invalid', `group ${id} does not exist`)
      if (groupOwner !== app.ownerId) throw new AppConnectRefusal('invalid', `group ${id} is not owned by the owner of app ${appId}`)
      continue
    }
    if (binding.kind === 'documentType' && ALLOWED_SYSTEM_DOCUMENT_TYPES.has(`${id}/${binding.documentTypeName}`)) continue
    const contract = await ports.contract(id)
    if (!contract) throw new AppConnectRefusal('invalid', `contract ${id} does not exist`)
    if (contract.ownerId !== app.ownerId) {
      throw new AppConnectRefusal('invalid', `contract ${id} is not owned by the owner of app ${appId} and is not an allowlisted system type`)
    }
  }

  for (const binding of request.encBindings) {
    if (!bytesEqual(binding.contractId, request.appId)) {
      throw new AppConnectRefusal('invalid', 'an encryption binding must name the app id')
    }
    const optIn = binding.purpose === KeyPurpose.ENCRYPTION
      ? app.requiresIdentityEncryptionBoundedKey
      : app.requiresIdentityDecryptionBoundedKey
    if (optIn === undefined) {
      throw new AppConnectRefusal('invalid', `app ${appId} does not opt in to bounded ${binding.purpose === KeyPurpose.ENCRYPTION ? 'encryption' : 'decryption'} keys`)
    }
  }
}

function buildPlan(request: AppConnectRequest, faults: AppConnectFaults, now: number): Plan {
  const auth = request.authBindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding, index }) => !(faults.omitProfile && index > 0 && binding.kind === 'documentType'))
  if (faults.omitProfile && request.authBindings[0].kind === 'documentType') {
    throw new AppConnectRefusal('declined', 'omit-profile declines the primary binding, which declines the request')
  }
  if (faults.critical && !auth.some(({ binding }) => binding.kind !== 'contractGroup')) {
    throw new AppConnectUsageError('critical needs a granted binding that is not a contractGroup')
  }
  if (faults.foreignGroup !== undefined && !auth.some(({ binding }) => binding.kind === 'contractGroup')) {
    throw new AppConnectUsageError('foreign-group needs a contractGroup binding in the request')
  }
  return {
    request,
    appId: bs58.encode(request.appId),
    requestHash: appConnectRequestHash(request),
    derivationTag: appConnectDerivationTag(request.appEphemeralPubKey),
    connectionId: request.connectionId ? bytesToHex(request.connectionId) : undefined,
    now,
    auth,
    enc: faults.omitEnc ? [] : request.encBindings.map((binding, index) => ({ binding, index })),
  }
}

/** Wallet rule 5: the binding's proposals clamped to the caps, then the limit faults. */
function grantedLimits(binding: AppConnectAuthBinding, now: number, faults: AppConnectFaults): { totalBudget?: bigint; expiresAt: number } {
  let totalBudget = binding.totalBudget === undefined ? undefined : minBigint(binding.totalBudget, BUDGET_CAP)
  let expiresAt = binding.expiresAt === undefined ? now + DEFAULT_LIFETIME_MS : Math.min(binding.expiresAt, now + LIFETIME_CAP_MS)
  if (faults.budget !== undefined) totalBudget = faults.budget
  if (faults.expired) expiresAt = now + EXPIRED_FAULT_MS
  if (faults.expiresInSeconds !== undefined) expiresAt = now + faults.expiresInSeconds * 1000
  return { totalBudget, expiresAt }
}

async function requireIdentityKeys(persona: Persona, ports: AppConnectPorts): Promise<AppConnectIdentityKey[]> {
  const keys = await ports.identityKeys(persona.identityId)
  if (!keys) throw new Error(`identity ${persona.identityId} (persona ${persona.personaIdx}) not found`)
  return keys
}

/** What re-derives a recorded grant key: the request's ephemeral key when the record has it, else its tag. */
function recordedSource(key: Pick<GrantedAuthKey, 'derivationTag' | 'appEphemeralPubKey'>): AuthKeySource {
  return {
    derivationTag: hexToBytes(key.derivationTag),
    ...(key.appEphemeralPubKey ? { appEphemeralPubKey: hexToBytes(key.appEphemeralPubKey) } : {}),
  }
}

/**
 * The grant key's private key when it re-derives to `chainKey`: proof that
 * this wallet made that key for this grant. Undefined otherwise, including
 * for a malformed record.
 */
function rederiveGrantKey(persona: Persona, grantKey: GrantedAuthKey, chainKey: AppConnectIdentityKey): Uint8Array | undefined {
  try {
    const privateKey = persona.connect.authKey(recordedSource(grantKey), grantKey.bindingIndex)
    return bytesEqual(chainKey.data, getYapprPublicKey(privateKey)) ? privateKey : undefined
  } catch {
    return undefined
  }
}

/** The grant's pending keys (an update with an unknown outcome) that are on chain, with their key ids. */
function resolvePendingKeys(persona: Persona, grant: ConnectionGrant, chainKeys: AppConnectIdentityKey[]): GrantedAuthKey[] {
  return (grant.pending ?? []).flatMap((pending) => {
    try {
      const privateKey = persona.connect.authKey(recordedSource(pending), pending.bindingIndex)
      const publicKey = getYapprPublicKey(privateKey)
      const chainKey = chainKeys.find((key) => bytesEqual(key.data, publicKey))
      return chainKey ? [{ ...pending, keyId: chainKey.id }] : []
    } catch {
      return []
    }
  })
}

/**
 * The stored grant keys that are still live on chain and provably this
 * wallet's App Connect auth keys (non-MASTER, and re-derived from the
 * record). A stale or edited state file cannot get anything else disabled,
 * the pool's own keys included.
 */
function liveGrantKeyIds(persona: Persona, stored: GrantedAuthKey[], chainKeys: AppConnectIdentityKey[]): number[] {
  return stored
    .filter((grantKey) => {
      const chainKey = chainKeys.find((key) => key.id === grantKey.keyId)
      return chainKey !== undefined
        && chainKey.disabledAt === undefined
        && chainKey.purpose === KeyPurpose.AUTHENTICATION
        && chainKey.securityLevel !== KeySecurityLevel.MASTER
        && rederiveGrantKey(persona, grantKey, chainKey) !== undefined
    })
    .map((grantKey) => grantKey.keyId)
}

/** One identity's answer: register (or renew) the keys, then publish the sealed response. */
async function answerAs(
  persona: Persona,
  plan: Plan,
  faults: AppConnectFaults,
  otherPersona: Persona | undefined,
  ports: AppConnectPorts,
): Promise<{ answer: AppConnectAnswer; values: ResponseValues }> {
  const chainKeys = await requireIdentityKeys(persona, ports)
  const record = ports.grants.get(persona.identityId, plan.appId)
  const previous = plan.connectionId === undefined ? undefined : record.connections[plan.connectionId]

  // Faults that shape the registered keys need fresh keys, so they always
  // answer as a login: a renewal can only raise limits, never cut them.
  const keyFault = faults.unregisteredKey || faults.unboundKey || faults.critical || faults.foreignGroup !== undefined
    || faults.expired || faults.expiresInSeconds !== undefined || faults.budget !== undefined
  const renewal = plan.request.mode === 'renew' && previous && !keyFault
    ? await planRenewal(persona, plan, previous, chainKeys, ports)
    : undefined
  const raisedKeyIds: number[] = []
  const toAdd: Array<{ slot: Slot; key: NewIdentityKey }> = []
  let authSlots: Slot[]

  if (renewal) {
    // The targets are saved before any update, so a retry of this request
    // finishes them instead of adding the allowance again.
    previous!.renewal = renewal.saved
    ports.grants.put(persona.identityId, plan.appId, record)
    for (const { chainKey, target } of renewal.keys) {
      const addBudget = target.totalBudget !== undefined && chainKey.totalBudget !== undefined && target.totalBudget > chainKey.totalBudget
        ? target.totalBudget - chainKey.totalBudget
        : undefined
      const expiresAt = target.expiresAt !== undefined && chainKey.expiresAt !== undefined && target.expiresAt > chainKey.expiresAt
        ? target.expiresAt
        : undefined
      if (addBudget === undefined && expiresAt === undefined) continue
      await ports.raiseKeyLimits(persona, chainKey.id, { addBudget, expiresAt })
      raisedKeyIds.push(chainKey.id)
    }
    authSlots = renewal.keys.map(({ slot }) => slot)
  } else {
    if (plan.request.mode === 'renew') ports.log(`persona ${persona.personaIdx}: no live grant to renew on this connection; answering as a new login`)
    authSlots = planAuthKeys(persona, plan, faults, chainKeys, toAdd)
  }

  const encSlots: Slot[] = []
  for (const { binding, index } of plan.enc) {
    const prepared = await prepareEncryptionKey(persona, plan, binding, index, chainKeys, ports)
    if (!prepared) continue
    encSlots.push(prepared.slot)
    if (prepared.register) toAdd.push({ slot: prepared.slot, key: prepared.register })
  }

  // Wallet rule 8: the previous grant on this connection goes in the same
  // update (not on a renewal, which keeps its keys; and never a key this
  // answer re-sends, as on a retry of the same request).
  // Keys from an earlier update whose outcome was unknown count as part of
  // the previous grant once they show up on chain.
  const previousKeys = previous ? [...previous.keys, ...resolvePendingKeys(persona, previous, chainKeys)] : []
  const disable = !renewal
    ? [...new Set(liveGrantKeyIds(persona, previousKeys, chainKeys))].filter((id) => !authSlots.some((slot) => slot.keyId === id))
    : []
  if (toAdd.length > MAX_KEYS_PER_UPDATE) {
    throw new AppConnectRefusal('invalid', `the grant needs ${toAdd.length} new keys; Platform adds at most ${MAX_KEYS_PER_UPDATE} per update`)
  }
  // Recorded before the update: if it lands but its confirmation fails, the
  // next login on this connection still finds and supersedes these keys.
  const pendingAuth = toAdd.filter(({ key }) => key.purpose === KeyPurpose.AUTHENTICATION)
  if (plan.connectionId !== undefined && !renewal && pendingAuth.length > 0) {
    const grant = record.connections[plan.connectionId] ?? { keys: [], grantedAt: new Date(plan.now).toISOString() }
    grant.pending = [
      ...(grant.pending ?? []),
      ...pendingAuth.map(({ slot }) => ({ bindingIndex: slot.bindingIndex, ...recordTags(plan), bounds: slot.bounds })),
    ]
    record.connections[plan.connectionId] = grant
    ports.grants.put(persona.identityId, plan.appId, record)
  }
  let addedKeyIds: number[] = []
  if (toAdd.length > 0 || disable.length > 0) {
    addedKeyIds = await ports.updateIdentity(persona, { add: toAdd.map(({ key }) => key), disable })
    toAdd.forEach(({ slot }, position) => {
      slot.keyId = addedKeyIds[position]
    })
  }

  // Saved before publishing, so a failed publish still lets the next login supersede these keys.
  if (plan.connectionId !== undefined && !renewal) {
    record.connections[plan.connectionId] = {
      keys: authSlots
        .filter((slot) => slot.keyId !== undefined)
        .map((slot): GrantedAuthKey => ({
          keyId: slot.keyId!,
          bindingIndex: slot.bindingIndex,
          ...recordTags(plan),
          bounds: slot.bounds,
        })),
      grantedAt: new Date(plan.now).toISOString(),
    }
    ports.grants.put(persona.identityId, plan.appId, record)
  }

  const slots = [...authSlots, ...encSlots]
  if (faults.extraSlot) slots.push({ role: 'extra', bindingIndex: slots.length, privateKey: secp256k1.utils.randomSecretKey() })
  const values = await sealAppConnectResponse({
    request: plan.request,
    ownerId: faults.wrongOwner ? otherPersona?.identityIdBytes ?? STRANGER_ID : persona.identityIdBytes,
    slots: slots.map((slot) => slot.privateKey),
    badTag: faults.badTag,
  })
  const published = await publish(persona, plan.appId, values, ports)

  return {
    values,
    answer: {
      personaIdx: persona.personaIdx,
      identityId: persona.identityId,
      mode: renewal ? 'renew' : 'login',
      slots: slots.map(({ role, bindingIndex, keyId }) => ({ role, bindingIndex, keyId })),
      addedKeyIds,
      disabledKeyIds: disable,
      raisedKeyIds,
      ...published,
    },
  }
}

/**
 * A login's auth keys: one per granted binding, derived from this request.
 * Keys for `toAdd` are appended to it. A key already live on the identity
 * (this exact request answered before, e.g. a retry after a failed publish)
 * is re-sent instead of registered again, which Platform would refuse.
 */
function planAuthKeys(
  persona: Persona,
  plan: Plan,
  faults: AppConnectFaults,
  chainKeys: AppConnectIdentityKey[],
  toAdd: Array<{ slot: Slot; key: NewIdentityKey }>,
): Slot[] {
  const source: AuthKeySource = { appEphemeralPubKey: plan.request.appEphemeralPubKey, derivationTag: plan.derivationTag }
  const firstNonGroup = plan.auth.find(({ binding }) => binding.kind !== 'contractGroup')?.index
  return plan.auth.map(({ binding, index }) => {
    const privateKey = persona.connect.authKey(source, index)
    const slot: Slot = { role: binding.kind, bindingIndex: index, privateKey }
    if (faults.unregisteredKey && index === 0) return slot

    const existing = chainKeys.find((key) => bytesEqual(key.data, getYapprPublicKey(privateKey)))
    if (existing) {
      if (existing.disabledAt !== undefined) {
        throw new AppConnectRefusal('failed', `the key for binding ${index} of this request has been disabled; start a new request`)
      }
      return { ...slot, keyId: existing.id, bounds: existing.bounds }
    }

    let bounds: AppConnectKeyBounds | undefined = authBindingBounds(binding)
    if (faults.unboundKey && index === 0) bounds = undefined
    if (faults.foreignGroup !== undefined && binding.kind === 'contractGroup') bounds = { kind: 'contractGroup', groupId: faults.foreignGroup }
    const securityLevel = faults.critical && index === firstNonGroup ? KeySecurityLevel.CRITICAL : binding.securityLevel
    slot.bounds = bounds
    toAdd.push({
      slot,
      key: { privateKey, purpose: KeyPurpose.AUTHENTICATION, securityLevel, bounds, ...grantedLimits(binding, plan.now, faults) },
    })
    return slot
  })
}

interface RenewalTarget {
  totalBudget?: bigint
  expiresAt?: number
}

interface RenewalPlan {
  keys: Array<{ chainKey: AppConnectIdentityKey; slot: Slot; target: RenewalTarget }>
  saved: StoredRenewal
}

/**
 * A renewal keeps the connection's keys when every requested binding matches
 * a live stored key this wallet re-derives, that already has the level and
 * limits the binding needs (a limit cannot be added later), and that will
 * have budget left after the raise. Otherwise it is answered as a new login,
 * which supersedes the old keys (the profile's phase-1 renewal).
 *
 * The target limits are fixed once per request and saved: a retry of the
 * same request reuses them, so the allowance is never added twice.
 */
async function planRenewal(
  persona: Persona,
  plan: Plan,
  previous: ConnectionGrant,
  chainKeys: AppConnectIdentityKey[],
  ports: AppConnectPorts,
): Promise<RenewalPlan | undefined> {
  // This request already answered as a new login (a retry): stay on that path,
  // which re-sends its keys, rather than raising the keys it just created.
  const derivationTag = bytesToHex(plan.derivationTag)
  if (previous.keys.some((key) => key.derivationTag === derivationTag)) return undefined
  const requestHash = bytesToHex(plan.requestHash)
  const saved = previous.renewal?.requestHash === requestHash ? previous.renewal.targets : undefined
  const keys: RenewalPlan['keys'] = []
  for (const { binding, index } of plan.auth) {
    const bounds = authBindingBounds(binding)
    const stored = previous.keys.find((key) => key.bounds !== undefined && boundsEqual(key.bounds, bounds))
    const chainKey = stored && chainKeys.find((key) => key.id === stored.keyId && key.disabledAt === undefined)
    if (!stored || !chainKey || !chainKey.bounds || !boundsEqual(chainKey.bounds, bounds) || !keyServesBinding(chainKey, binding)) {
      return undefined
    }
    const privateKey = rederiveGrantKey(persona, stored, chainKey)
    if (!privateKey) {
      ports.log(`persona ${persona.personaIdx}: key ${chainKey.id} does not re-derive from the grant record`)
      return undefined
    }
    const savedTarget = saved?.[chainKey.id]
    const target = savedTarget
      ? { totalBudget: savedTarget.totalBudget === undefined ? undefined : BigInt(savedTarget.totalBudget), expiresAt: savedTarget.expiresAt }
      : renewalTarget(binding, chainKey, plan.now)
    keys.push({ chainKey, target, slot: { role: binding.kind, bindingIndex: index, privateKey, keyId: chainKey.id, bounds } })
  }

  const budgeted = keys.filter(({ chainKey }) => chainKey.totalBudget !== undefined)
  if (budgeted.length > 0) {
    const remaining = await ports.remainingBudgets(persona.identityId, budgeted.map(({ chainKey }) => chainKey.id))
    for (const { chainKey, target } of budgeted) {
      const raise = (target.totalBudget ?? 0n) - chainKey.totalBudget!
      if ((remaining.get(chainKey.id) ?? 0n) + (raise > 0n ? raise : 0n) <= 0n) {
        ports.log(`persona ${persona.personaIdx}: key ${chainKey.id} would have no budget left within the cap`)
        return undefined
      }
    }
  }

  return {
    keys,
    saved: {
      requestHash,
      targets: Object.fromEntries(keys.map(({ chainKey, target }) => [chainKey.id, {
        totalBudget: target.totalBudget?.toString(),
        expiresAt: target.expiresAt,
      }])),
    },
  }
}

/** Whether an existing key can stand for the binding: the level verifiers accept, and every limit the binding needs. */
function keyServesBinding(key: AppConnectIdentityKey, binding: AppConnectAuthBinding): boolean {
  if (key.purpose !== KeyPurpose.AUTHENTICATION) return false
  const levelOk = binding.kind === 'contractGroup'
    ? (key.securityLevel === KeySecurityLevel.CRITICAL || key.securityLevel === KeySecurityLevel.HIGH) && key.securityLevel >= binding.securityLevel
    : key.securityLevel === KeySecurityLevel.HIGH
  const budgetOk = !(binding.kind === 'contractGroup' || binding.totalBudget !== undefined) || key.totalBudget !== undefined
  const expiryOk = binding.expiresAt === undefined || key.expiresAt !== undefined
  return levelOk && budgetOk && expiryOk
}

/** The renewed limits: the proposal added to the total (within the cap), the expiry moved out. */
function renewalTarget(binding: AppConnectAuthBinding, key: AppConnectIdentityKey, now: number): RenewalTarget {
  const wanted = grantedLimits(binding, now, noFaults())
  let totalBudget = key.totalBudget
  if (totalBudget !== undefined && wanted.totalBudget !== undefined) {
    const add = minBigint(wanted.totalBudget, BUDGET_CAP - totalBudget)
    if (add > 0n) totalBudget += add
  }
  const expiresAt = key.expiresAt === undefined ? undefined : Math.max(key.expiresAt, wanted.expiresAt)
  return { totalBudget, expiresAt }
}

/**
 * Wallet rule 7: one encryption key per (identity, app), shared by every
 * device, with dashwallet-ios #1210's states: re-send the current key when
 * this wallet derives it (a legacy persona at any rotation an operator
 * registered, e.g. `scripts/verify-appconnect.mjs --restore-anchor-key`),
 * register rotation 0 when there is none, and leave the slot out when another
 * wallet made the current one or rotation 0 was disabled. Never rotate.
 */
async function prepareEncryptionKey(
  persona: Persona,
  plan: Plan,
  binding: AppConnectEncBinding,
  index: number,
  chainKeys: AppConnectIdentityKey[],
  ports: AppConnectPorts,
): Promise<{ slot: Slot; register?: NewIdentityKey } | undefined> {
  // Rotation 0 first. A seeded persona holds rotation 0 only (#1210); a legacy one may hold later
  // rotations an operator registered, each its own key added lowest first, so fewer exist than the keys it holds.
  const held = persona.connect.encryptionKeys(binding.contractId, binding.purpose, chainKeys.length)
  const privateKey = held[0]
  const publicKey = getYapprPublicKey(privateKey)
  const role: AppConnectSlotRole = binding.purpose === KeyPurpose.ENCRYPTION ? 'encryption' : 'decryption'
  const current = (await ports.contractKeys(persona.identityId, bs58.encode(binding.contractId), binding.purpose))
    .filter((key) => key.disabledAt === undefined)

  if (current.length > 0) {
    for (const candidate of held) {
      const candidatePublicKey = getYapprPublicKey(candidate)
      const mine = current.find((key) => bytesEqual(key.data, candidatePublicKey))
      if (mine) return { slot: { role, bindingIndex: index, privateKey: candidate, keyId: mine.id } }
    }
    ports.log(`persona ${persona.personaIdx}: the ${role} key for app ${plan.appId} was made by another wallet; slot omitted`)
    return undefined
  }
  if (chainKeys.some((key) => bytesEqual(key.data, publicKey))) {
    ports.log(`persona ${persona.personaIdx}: the ${role} key for app ${plan.appId} is on the identity but not current (disabled?); slot omitted`)
    return undefined
  }
  return {
    slot: { role, bindingIndex: index, privateKey },
    register: { privateKey, purpose: binding.purpose, securityLevel: KeySecurityLevel.MEDIUM, bounds: encBindingBounds(binding) },
  }
}

export interface SealResponseInput {
  request: Pick<AppConnectRequest, 'appEphemeralPubKey'>
  /** The `$ownerId` the AAD names. */
  ownerId: Uint8Array
  slots: Uint8Array[]
  /** bad-tag: flip one bit of the GCM tag. */
  badTag?: boolean
  /** Fixed only for test vectors. */
  walletEphemeralPrivateKey?: Uint8Array
  nonce?: Uint8Array
}

/** The response's three values, sealed with the shared App Connect crypto. */
export async function sealAppConnectResponse(input: SealResponseInput): Promise<ResponseValues> {
  const { walletEphemeralPubKey, encryptedPayload } = await sealAppConnectPayload({
    appEphemeralPubKey: input.request.appEphemeralPubKey,
    ownerId: input.ownerId,
    slots: input.slots,
    walletEphemeralPrivateKey: input.walletEphemeralPrivateKey,
    nonce: input.nonce,
  })
  if (input.badTag) encryptedPayload[encryptedPayload.length - 1] ^= 0x01
  return { appEphemeralPubKeyHash: appConnectRequestHash(input.request), walletEphemeralPubKey, encryptedPayload }
}

/** spam: a well-framed response that opens for nobody. */
function junkResponse(plan: Plan): ResponseValues {
  const slots = Math.max(1, plan.auth.length + plan.enc.length)
  return {
    appEphemeralPubKeyHash: plan.requestHash,
    walletEphemeralPubKey: getYapprPublicKey(secp256k1.utils.randomSecretKey()),
    encryptedPayload: crypto.getRandomValues(new Uint8Array(APP_CONNECT_ENVELOPE_BYTES + APP_CONNECT_SLOT_BYTES * slots)),
  }
}

/**
 * Wallet rule 9: delete the responses this wallet published earlier for the
 * identity and app (by their values), then create the new one. A delete
 * Platform refused with DocumentNotFoundError (the entry is gone) is dropped
 * from the record; any other failure keeps it for the next answer. Spam junk
 * (`replacePrevious: false`) only replaces an earlier answer to the same
 * request (a retry), never a live response to another one.
 */
async function publish(
  persona: Persona,
  appId: string,
  values: ResponseValues,
  ports: AppConnectPorts,
  { replacePrevious = true } = {},
): Promise<{ deletedResponses: number; documentId?: string; confirmed: boolean }> {
  const record = ports.grants.get(persona.identityId, appId)
  const requestHash = bytesToHex(values.appEphemeralPubKeyHash)
  let deletedResponses = 0
  const kept: StoredResponse[] = []
  for (const old of record.responses) {
    if (!replacePrevious && old.appEphemeralPubKeyHash !== requestHash) {
      kept.push(old)
      continue
    }
    try {
      await ports.deleteResponse(persona, old)
      deletedResponses++
    } catch (error) {
      ports.log(`persona ${persona.personaIdx}: deleting the response to ${old.appEphemeralPubKeyHash} failed: ${errorMessage(error)}`)
      // Forget it only when Platform says the entry is not there.
      if (consensusCode(error) !== DOCUMENT_NOT_FOUND) kept.push(old)
    }
  }
  record.responses = kept
  ports.grants.put(persona.identityId, appId, record)

  // Recorded before the create: if its outcome is unknown (a dropped
  // connection, a crash), the next answer still holds the values the
  // index-only delete needs. Only a consensus refusal proves it never landed.
  const attempted: StoredResponse = {
    appEphemeralPubKeyHash: requestHash,
    walletEphemeralPubKey: bytesToHex(values.walletEphemeralPubKey),
    encryptedPayload: bytesToHex(values.encryptedPayload),
  }
  record.responses.push(attempted)
  ports.grants.put(persona.identityId, appId, record)
  let created: { documentId?: string; confirmed: boolean }
  try {
    created = await ports.createResponse(persona, values)
  } catch (error) {
    if (consensusCode(error) !== undefined) {
      record.responses = record.responses.filter((response) => response !== attempted)
      ports.grants.put(persona.identityId, appId, record)
    }
    throw error
  }
  attempted.documentId = created.documentId
  ports.grants.put(persona.identityId, appId, record)
  return { deletedResponses, ...created }
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
