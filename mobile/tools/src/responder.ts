/**
 * Answers one `dash-key:` or `dash-st:` URI for one pool persona. Platform
 * access goes through the {@link ResponderPorts} so the whole exchange runs in
 * unit tests with the write and the broadcast stubbed.
 */
import bs58 from 'bs58'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { IdentityPublicKey, StateTransition } from '@dashevo/evo-sdk'
import {
  parseYapprKeyExchangeUri,
  parseYapprStateTransitionUri,
  serializeYapprKeyExchangeRequest,
  type YapprKeyExchangeRequest,
} from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import type { YapprKeyExchangeNetworkName } from '../../../vendor/platform-auth/src/core/types'
import { answerKeyExchange, type LoginKeyResponseFields } from './key-exchange'
import { decodeIdentityUpdate, inspectIdentityUpdate, signIdentityUpdate } from './dash-st'
import type { Persona } from './pool'

/** The pool is sakura's: requests for any other network are refused, so nothing reaches testnet or mainnet. */
const SERVED_NETWORK: YapprKeyExchangeNetworkName = 'devnet'

/** The persona's current `loginKeyResponse` for one app contract. */
export interface StoredResponse {
  documentId: string
  revision: bigint
  keyIndex: number
}

export interface WriteOutcome {
  documentId: string
  action: 'created' | 'replaced'
  /** False when the broadcast went out but its confirmation timed out. */
  confirmed: boolean
}

export interface BroadcastOutcome {
  transitionHash: string
  confirmed: boolean
}

export interface ResponderPorts {
  findLoginKeyResponse(persona: Persona, appContractId: Uint8Array): Promise<StoredResponse | undefined>
  /** Creates the response, or replaces `existing`; signed with keyId 2 (HIGH). */
  writeLoginKeyResponse(persona: Persona, fields: LoginKeyResponseFields, existing: StoredResponse | undefined): Promise<WriteOutcome>
  /** The persona's on-chain keyId 0, checked against the pool's MASTER key. */
  masterKey(persona: Persona): Promise<IdentityPublicKey>
  /** Refuses a stale nonce before anything is signed. */
  checkIdentityUpdate(persona: Persona, stateTransition: StateTransition): Promise<void>
  broadcast(stateTransition: StateTransition): Promise<BroadcastOutcome>
}

export interface RespondInput {
  uri: string
  persona: Persona
  /** Rotation: ask for this keyIndex instead of reusing the stored one. */
  keyIndex?: number
}

export type RespondResult =
  | ({
      kind: 'dash-key'
      personaIdx: number
      identityId: string
      appContractId: string
      appEphemeralPubKeyHash: string
      keyIndex: number
      label: string | undefined
    } & WriteOutcome)
  | ({
      kind: 'dash-st'
      personaIdx: number
      identityId: string
      signaturePublicKeyId: number
      addedKeyIds: number[]
    } & BroadcastOutcome)

export async function respond(input: RespondInput, ports: ResponderPorts): Promise<RespondResult> {
  const { uri } = input
  if (uri.startsWith('dash-key:')) return respondToKeyExchange(input, ports)
  if (uri.startsWith('dash-st:')) return respondToStateTransition(input, ports)
  throw new Error('Unsupported URI: expected dash-key: or dash-st:')
}

async function respondToKeyExchange(input: RespondInput, ports: ResponderPorts): Promise<RespondResult> {
  const parsed = parseYapprKeyExchangeUri(input.uri)
  // Spec §10.2: no bytes after the label (the vendor parser ignores them).
  if (!parsed || !isExactRequest(input.uri, parsed.request)) throw new Error('Malformed dash-key: request')
  requireServedNetwork(parsed.network)

  const { persona } = input
  const { request } = parsed
  // Spec §12.2: reuse the stored index (a normal re-login); a requested
  // rotation may move it forward, never back.
  const existing = await ports.findLoginKeyResponse(persona, request.contractId)
  if (input.keyIndex !== undefined && existing && input.keyIndex < existing.keyIndex) {
    throw new Error(`keyIndex ${input.keyIndex} is below the stored ${existing.keyIndex} (rollback refused, spec §12.2)`)
  }
  const keyIndex = input.keyIndex ?? existing?.keyIndex ?? 0

  const fields = await answerKeyExchange({
    request,
    identityId: persona.identityIdBytes,
    baseKey: persona.key('critical').privateKey,
    keyIndex,
  })
  const outcome = await ports.writeLoginKeyResponse(persona, fields, existing)
  return {
    kind: 'dash-key',
    personaIdx: persona.personaIdx,
    identityId: persona.identityId,
    appContractId: bs58.encode(request.contractId),
    appEphemeralPubKeyHash: bytesToHex(fields.appEphemeralPubKeyHash),
    keyIndex,
    label: request.label,
    ...outcome,
  }
}

async function respondToStateTransition(input: RespondInput, ports: ResponderPorts): Promise<RespondResult> {
  const parsed = parseYapprStateTransitionUri(input.uri)
  if (!parsed) throw new Error('Malformed dash-st: request')
  requireServedNetwork(parsed.network)
  // Spec §11.5: a `k=` signing key must be the MASTER key.
  const signingKey = new URLSearchParams(input.uri.slice(input.uri.indexOf('?') + 1)).get('k')
  if (signingKey !== null && signingKey !== '0') throw new Error(`dash-st: k=${signingKey} is not the MASTER key (keyId 0)`)

  const { persona } = input
  const stateTransition = decodeIdentityUpdate(parsed.transitionBytes)
  // Before any network call: never sign for an identity but the persona's.
  const owner = stateTransition.ownerId?.toBase58()
  if (owner !== persona.identityId) {
    throw new Error(`dash-st: transition updates identity ${owner ?? '(none)'}, not the persona's ${persona.identityId}`)
  }
  const { addedKeyIds } = inspectIdentityUpdate(stateTransition)
  await ports.checkIdentityUpdate(persona, stateTransition)
  const masterPublicKey = await ports.masterKey(persona)
  signIdentityUpdate(stateTransition, persona.key('master').privateKey, masterPublicKey)
  const outcome = await ports.broadcast(stateTransition)
  return {
    kind: 'dash-st',
    personaIdx: persona.personaIdx,
    identityId: persona.identityId,
    signaturePublicKeyId: stateTransition.signaturePublicKeyId ?? -1,
    addedKeyIds,
    ...outcome,
  }
}

function isExactRequest(uri: string, request: YapprKeyExchangeRequest): boolean {
  const payload = bs58.decode(uri.slice('dash-key:'.length, uri.indexOf('?')))
  return bytesToHex(payload) === bytesToHex(serializeYapprKeyExchangeRequest(request))
}

function requireServedNetwork(requested: YapprKeyExchangeNetworkName): void {
  if (requested !== SERVED_NETWORK) {
    throw new Error(`Request is for ${requested}; this responder serves ${SERVED_NETWORK} (sakura pool identities only)`)
  }
}
