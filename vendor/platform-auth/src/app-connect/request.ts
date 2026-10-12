import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import type { YapprKeyExchangeNetworkName } from '../core/types'
import { YAPPR_NETWORK_IDS, hash160 } from '../key-exchange/yappr-protocol'
import { KeyPurpose, KeySecurityLevel, type AppConnectKeyBounds } from './types'

/**
 * App Connect request v2 (docs/APP_CONNECT_PROFILE.md):
 *
 *   body = 0x02 ‖ appEphPub(33) ‖ appId(32) ‖ labelLen(1) ‖ label ‖ TLV*
 *   TLV  = type(1) ‖ len(1) ‖ value
 *   uri  = dash-key:<base58(body)>?n=<m|t|d>&v=2[&cb=<https URL>]
 *
 * Even TLV types must be understood (a decoder refuses unknown ones); odd
 * types are optional and unknown ones are skipped. TLVs appear in ascending
 * type order and only AUTH_BINDING and ENC_BINDING repeat, so every request
 * has exactly one encoding.
 */

export const APP_CONNECT_REQUEST_VERSION = 2
export const APP_CONNECT_MAX_LABEL_BYTES = 64
export const APP_CONNECT_MAX_AUTH_BINDINGS = 4
export const APP_CONNECT_MAX_ENC_BINDINGS = 2
export const APP_CONNECT_MAX_CALLBACK_LENGTH = 512
/** A wallet refuses a request created longer ago than this... */
export const APP_CONNECT_MAX_REQUEST_AGE_MS = 10 * 60_000
/** ...or further in the future than this (clock skew). */
export const APP_CONNECT_MAX_REQUEST_SKEW_MS = 2 * 60_000

export const AppConnectTlv = {
  IDENTITY_HINT: 0x01,
  AUTH_BINDING: 0x02,
  CONNECTION_ID: 0x03,
  ENC_BINDING: 0x04,
  MODE: 0x05,
  CREATED_AT: 0x06,
} as const

/** Wire tags of AUTH_BINDING kinds; equal to Platform's `ContractBounds` bincode tags. */
const BINDING_KIND_TAGS = { singleContract: 0, documentType: 1, contractGroup: 2 } as const

export type AppConnectBindingKind = keyof typeof BINDING_KIND_TAGS
/** Absent means login; MODE carries only renew. */
export type AppConnectMode = 'renew'

export interface AppConnectAuthBinding {
  kind: AppConnectBindingKind
  /** Contract id, or the group id for `contractGroup`. */
  id: Uint8Array
  /** Required for `documentType`, absent otherwise. */
  documentTypeName?: string
  /** CRITICAL only on `contractGroup`; HIGH everywhere. */
  securityLevel: number
  /** Proposed lifetime budget in credits; mandatory on `contractGroup`. Zero on the wire means none. */
  totalBudget?: bigint
  /** Proposed expiry, block time in ms. Zero on the wire means none. */
  expiresAt?: number
}

export interface AppConnectEncBinding {
  contractId: Uint8Array
  /** ENCRYPTION or DECRYPTION. */
  purpose: number
}

export interface AppConnectRequest {
  appEphemeralPubKey: Uint8Array
  appId: Uint8Array
  label: string
  /** 1–4; the first is the primary binding a wallet may not decline on its own. */
  authBindings: AppConnectAuthBinding[]
  encBindings: AppConnectEncBinding[]
  /** ms since epoch. */
  createdAt: number
  identityHint?: Uint8Array
  connectionId?: Uint8Array
  mode?: AppConnectMode
}

export interface ParsedAppConnectUri {
  request: AppConnectRequest
  requestBytes: Uint8Array
  network: YapprKeyExchangeNetworkName
  callbackUrl?: string
}

/**
 * `unsupported`: a version or mandatory field this decoder does not know (a
 * newer app); `invalid`: anything else that breaks the format.
 */
export type AppConnectRequestErrorCode = 'unsupported' | 'invalid'

export class AppConnectRequestError extends Error {
  readonly code: AppConnectRequestErrorCode

  constructor(code: AppConnectRequestErrorCode, message: string) {
    super(message)
    this.name = 'AppConnectRequestError'
    this.code = code
  }
}

const encoder = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF instead of silently dropping it.
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const DOCUMENT_TYPE_NAME = /^[A-Za-z0-9_-]{1,64}$/
// C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates a label could use to disguise itself.
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const AUTH_BINDING_FIXED_BYTES = 1 + 1 + 32 + 8 + 8
const ENC_BINDING_BYTES = 33
const FIXED_VALUE_BYTES: Partial<Record<number, number>> = {
  [AppConnectTlv.IDENTITY_HINT]: 32,
  [AppConnectTlv.CONNECTION_ID]: 16,
  [AppConnectTlv.ENC_BINDING]: ENC_BINDING_BYTES,
  [AppConnectTlv.MODE]: 1,
  [AppConnectTlv.CREATED_AT]: 8,
}
const MAX_U64 = (1n << 64n) - 1n
const KNOWN_TLV_TYPES: ReadonlySet<number> = new Set(Object.values(AppConnectTlv))

function invalid(message: string): never {
  throw new AppConnectRequestError('invalid', message)
}

/** `hash160(appEphPub)`: the `appEphemeralPubKeyHash` responses are stored under. */
export function appConnectRequestHash(request: Pick<AppConnectRequest, 'appEphemeralPubKey'>): Uint8Array {
  return hash160(request.appEphemeralPubKey)
}

/** The key bounds an auth binding asks for, with base58 ids. */
export function authBindingBounds(binding: AppConnectAuthBinding): AppConnectKeyBounds {
  const id = bs58.encode(binding.id)
  switch (binding.kind) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: id }
    case 'documentType':
      return { kind: 'documentType', contractId: id, documentTypeName: binding.documentTypeName ?? '' }
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: id }
  }
}

/** The key bounds an encryption binding asks for: `singleContract` on its contract. */
export function encBindingBounds(binding: AppConnectEncBinding): AppConnectKeyBounds {
  return { kind: 'singleContract', contractId: bs58.encode(binding.contractId) }
}

/**
 * Checks the protocol rules every request obeys, whoever built it. The encoder
 * runs it before writing and the decoder after reading, so neither side can
 * produce or accept a request the other would refuse.
 */
export function validateAppConnectRequest(request: AppConnectRequest): void {
  checkPublicKey(request.appEphemeralPubKey)
  checkLength(request.appId, 32, 'app id')
  if (encoder.encode(request.label).length > APP_CONNECT_MAX_LABEL_BYTES) {
    invalid(`label is longer than ${APP_CONNECT_MAX_LABEL_BYTES} bytes`)
  }
  if (LABEL_FORBIDDEN.test(request.label)) invalid('label contains control or bidirectional formatting characters')

  const { authBindings, encBindings } = request
  if (authBindings.length < 1 || authBindings.length > APP_CONNECT_MAX_AUTH_BINDINGS) {
    invalid(`expected 1 to ${APP_CONNECT_MAX_AUTH_BINDINGS} auth bindings, got ${authBindings.length}`)
  }
  const seenBounds = new Set<string>()
  for (const binding of authBindings) {
    checkAuthBinding(binding)
    const key = `${binding.kind}:${bs58.encode(binding.id)}:${binding.documentTypeName ?? ''}`
    if (seenBounds.has(key)) invalid('duplicate auth binding')
    seenBounds.add(key)
  }

  if (encBindings.length > APP_CONNECT_MAX_ENC_BINDINGS) {
    invalid(`expected at most ${APP_CONNECT_MAX_ENC_BINDINGS} encryption bindings, got ${encBindings.length}`)
  }
  const seenEnc = new Set<string>()
  for (const binding of encBindings) {
    checkLength(binding.contractId, 32, 'encryption binding contract id')
    if (binding.purpose !== KeyPurpose.ENCRYPTION && binding.purpose !== KeyPurpose.DECRYPTION) {
      invalid(`encryption binding purpose ${binding.purpose} is not ENCRYPTION or DECRYPTION`)
    }
    const key = `${bs58.encode(binding.contractId)}:${binding.purpose}`
    if (seenEnc.has(key)) invalid('duplicate encryption binding')
    seenEnc.add(key)
  }

  if (!Number.isSafeInteger(request.createdAt) || request.createdAt <= 0) {
    invalid('created-at must be a positive millisecond timestamp')
  }
  if (request.identityHint !== undefined) checkLength(request.identityHint, 32, 'identity hint')
  if (request.connectionId !== undefined) checkLength(request.connectionId, 16, 'connection id')
  if (request.mode !== undefined && request.mode !== 'renew') {
    invalid(`unknown mode ${String(request.mode)}`)
  }
}

function checkAuthBinding(binding: AppConnectAuthBinding): void {
  // hasOwn, not `in`: 'toString' is `in` every object.
  if (!Object.hasOwn(BINDING_KIND_TAGS, binding.kind)) invalid(`unknown binding kind ${String(binding.kind)}`)
  checkLength(binding.id, 32, 'binding id')

  if (binding.kind === 'documentType') {
    if (binding.documentTypeName === undefined || !DOCUMENT_TYPE_NAME.test(binding.documentTypeName)) {
      invalid('a documentType binding needs a document type name of 1-64 [A-Za-z0-9_-]')
    }
  } else if (binding.documentTypeName !== undefined) {
    invalid(`a ${binding.kind} binding carries no document type name`)
  }

  const level = binding.securityLevel
  const levelAllowed = binding.kind === 'contractGroup'
    ? level === KeySecurityLevel.CRITICAL || level === KeySecurityLevel.HIGH
    : level === KeySecurityLevel.HIGH
  if (!levelAllowed) {
    invalid(`security level ${binding.securityLevel} is not allowed on a ${binding.kind} binding`)
  }

  if (binding.totalBudget !== undefined && (binding.totalBudget <= 0n || binding.totalBudget > MAX_U64)) {
    invalid('total budget must be between 1 and 2^64-1 credits')
  }
  if (binding.kind === 'contractGroup' && binding.totalBudget === undefined) {
    invalid('a contractGroup binding must carry a budget')
  }
  if (binding.expiresAt !== undefined && (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0)) {
    invalid('expires-at must be a positive millisecond timestamp')
  }
}

function checkLength(bytes: Uint8Array, expected: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
    invalid(`${what} must be ${expected} bytes`)
  }
}

function checkPublicKey(publicKey: Uint8Array): void {
  checkLength(publicKey, 33, 'app ephemeral public key')
  try {
    secp256k1.Point.fromBytes(publicKey)
  } catch {
    invalid('app ephemeral public key is not a compressed secp256k1 point')
  }
}

export function encodeAppConnectRequest(request: AppConnectRequest): Uint8Array {
  validateAppConnectRequest(request)

  const out: number[] = [APP_CONNECT_REQUEST_VERSION, ...request.appEphemeralPubKey, ...request.appId]
  const label = encoder.encode(request.label)
  out.push(label.length, ...label)

  const tlv = (type: number, value: Uint8Array) => {
    out.push(type, value.length, ...value)
  }
  if (request.identityHint) tlv(AppConnectTlv.IDENTITY_HINT, request.identityHint)
  for (const binding of request.authBindings) tlv(AppConnectTlv.AUTH_BINDING, encodeAuthBinding(binding))
  if (request.connectionId) tlv(AppConnectTlv.CONNECTION_ID, request.connectionId)
  for (const binding of request.encBindings) {
    tlv(AppConnectTlv.ENC_BINDING, Uint8Array.of(...binding.contractId, binding.purpose))
  }
  if (request.mode === 'renew') tlv(AppConnectTlv.MODE, Uint8Array.of(1))
  tlv(AppConnectTlv.CREATED_AT, u64(BigInt(request.createdAt)))

  return Uint8Array.from(out)
}

function encodeAuthBinding(binding: AppConnectAuthBinding): Uint8Array {
  const name = binding.documentTypeName === undefined ? [] : [...encoder.encode(binding.documentTypeName)]
  return Uint8Array.from([
    BINDING_KIND_TAGS[binding.kind],
    binding.securityLevel,
    ...binding.id,
    ...u64(binding.totalBudget ?? 0n),
    ...u64(BigInt(binding.expiresAt ?? 0)),
    ...(name.length > 0 ? [name.length, ...name] : []),
  ])
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value)
  return bytes
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset)
}

function readMs(bytes: Uint8Array, offset: number, what: string): number | undefined {
  const value = readU64(bytes, offset)
  if (value === 0n) return undefined
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(`${what} is out of range`)
  return Number(value)
}

export function decodeAppConnectRequest(bytes: Uint8Array): AppConnectRequest {
  if (bytes.length < 1) invalid('empty request')
  if (bytes[0] !== APP_CONNECT_REQUEST_VERSION) {
    throw new AppConnectRequestError('unsupported', `unsupported request version ${bytes[0]}`)
  }
  if (bytes.length < 1 + 33 + 32 + 1) invalid('request is truncated')

  let offset = 1
  const appEphemeralPubKey = bytes.slice(offset, offset + 33)
  offset += 33
  const appId = bytes.slice(offset, offset + 32)
  offset += 32
  const labelLength = bytes[offset++]
  if (labelLength > APP_CONNECT_MAX_LABEL_BYTES) invalid('label is too long')
  if (offset + labelLength > bytes.length) invalid('request is truncated')
  let label: string
  try {
    label = strictDecoder.decode(bytes.subarray(offset, offset + labelLength))
  } catch {
    invalid('label is not valid UTF-8')
  }
  offset += labelLength

  const request: AppConnectRequest = {
    appEphemeralPubKey,
    appId,
    label,
    authBindings: [],
    encBindings: [],
    createdAt: 0,
  }
  let previousType = 0
  let sawCreatedAt = false

  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) invalid('TLV header is truncated')
    const type = bytes[offset]
    const length = bytes[offset + 1]
    offset += 2
    if (offset + length > bytes.length) invalid(`TLV 0x${hex2(type)} is truncated`)
    const value = bytes.subarray(offset, offset + length)
    offset += length

    // The repeatable known types, and any unknown optional type (a future one may repeat).
    const repeatable = type === AppConnectTlv.AUTH_BINDING || type === AppConnectTlv.ENC_BINDING
      || (type % 2 === 1 && !KNOWN_TLV_TYPES.has(type))
    if (type < previousType || (type === previousType && !repeatable)) {
      invalid(`TLV 0x${hex2(type)} is out of order or repeated`)
    }
    previousType = type

    const fixed = FIXED_VALUE_BYTES[type]
    if (fixed !== undefined && length !== fixed) invalid(`TLV 0x${hex2(type)} must be ${fixed} bytes`)

    switch (type) {
      case AppConnectTlv.IDENTITY_HINT:
        request.identityHint = value.slice()
        break
      case AppConnectTlv.AUTH_BINDING:
        if (request.authBindings.length === APP_CONNECT_MAX_AUTH_BINDINGS) invalid('too many auth bindings')
        request.authBindings.push(decodeAuthBinding(value))
        break
      case AppConnectTlv.CONNECTION_ID:
        request.connectionId = value.slice()
        break
      case AppConnectTlv.ENC_BINDING:
        if (request.encBindings.length === APP_CONNECT_MAX_ENC_BINDINGS) invalid('too many encryption bindings')
        request.encBindings.push({ contractId: value.slice(0, 32), purpose: value[32] })
        break
      case AppConnectTlv.MODE:
        if (value[0] !== 1) invalid(`unknown mode ${value[0]}`)
        request.mode = 'renew'
        break
      case AppConnectTlv.CREATED_AT:
        request.createdAt = readMs(value, 0, 'created-at') ?? invalid('created-at is zero')
        sawCreatedAt = true
        break
      default:
        if (type % 2 === 0) {
          throw new AppConnectRequestError('unsupported', `unknown mandatory TLV 0x${hex2(type)}`)
        }
    }
  }

  if (!sawCreatedAt) invalid('request has no created-at')
  validateAppConnectRequest(request)
  return request
}

function decodeAuthBinding(value: Uint8Array): AppConnectAuthBinding {
  if (value.length < AUTH_BINDING_FIXED_BYTES) invalid('auth binding is truncated')
  const tag = value[0]
  const kind = (Object.keys(BINDING_KIND_TAGS) as AppConnectBindingKind[]).find((k) => BINDING_KIND_TAGS[k] === tag)
  if (kind === undefined) {
    throw new AppConnectRequestError('unsupported', `unknown auth binding kind ${tag}`)
  }

  const binding: AppConnectAuthBinding = {
    kind,
    securityLevel: value[1],
    id: value.slice(2, 34),
  }
  const budget = readU64(value, 34)
  if (budget > 0n) binding.totalBudget = budget
  const expiresAt = readMs(value, 42, 'expires-at')
  if (expiresAt !== undefined) binding.expiresAt = expiresAt

  const rest = value.subarray(AUTH_BINDING_FIXED_BYTES)
  if (kind === 'documentType') {
    if (rest.length < 1 || rest[0] + 1 !== rest.length) invalid('document type name length does not match')
    try {
      binding.documentTypeName = strictDecoder.decode(rest.subarray(1))
    } catch {
      invalid('document type name is not valid UTF-8')
    }
  } else if (rest.length !== 0) {
    invalid(`a ${kind} binding carries trailing bytes`)
  }
  return binding
}

function hex2(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

/** `cb` must be an absolute https URL without credentials. */
function checkCallbackUrl(callbackUrl: string): void {
  if (callbackUrl.length > APP_CONNECT_MAX_CALLBACK_LENGTH) invalid('callback URL is too long')
  let url: URL
  try {
    url = new URL(callbackUrl)
  } catch {
    invalid('callback URL is not a URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    invalid('callback URL must be https without credentials')
  }
}

export function buildAppConnectUri(
  request: AppConnectRequest,
  network: YapprKeyExchangeNetworkName,
  callbackUrl?: string,
): string {
  const body = bs58.encode(encodeAppConnectRequest(request))
  let uri = `dash-key:${body}?n=${YAPPR_NETWORK_IDS[network]}&v=${APP_CONNECT_REQUEST_VERSION}`
  if (callbackUrl !== undefined) {
    checkCallbackUrl(callbackUrl)
    uri += `&cb=${encodeURIComponent(callbackUrl)}`
  }
  return uri
}

/**
 * Parses a `dash-key:` v2 URI. Throws {@link AppConnectRequestError}; a v1 URI
 * is `unsupported` here (it belongs to the legacy key exchange).
 */
export function parseAppConnectUri(uri: string): ParsedAppConnectUri {
  if (!uri.startsWith('dash-key:')) invalid('not a dash-key URI')
  const rest = uri.slice('dash-key:'.length)
  const queryStart = rest.indexOf('?')
  if (queryStart === -1) invalid('URI has no query')

  const params = new URLSearchParams(rest.slice(queryStart + 1))
  for (const name of ['n', 'v', 'cb']) {
    if (params.getAll(name).length > 1) invalid(`query parameter ${name} is repeated`)
  }
  const version = params.get('v')
  if (version !== String(APP_CONNECT_REQUEST_VERSION)) {
    throw new AppConnectRequestError('unsupported', `unsupported URI version ${version ?? '(none)'}`)
  }
  const networkId = params.get('n')
  const network = (Object.keys(YAPPR_NETWORK_IDS) as YapprKeyExchangeNetworkName[])
    .find((name) => YAPPR_NETWORK_IDS[name] === networkId)
  if (network === undefined) invalid(`unknown network ${networkId ?? '(none)'}`)

  let requestBytes: Uint8Array
  try {
    requestBytes = bs58.decode(rest.slice(0, queryStart))
  } catch {
    invalid('request is not base58')
  }

  const callbackUrl = params.get('cb') ?? undefined
  if (callbackUrl !== undefined) checkCallbackUrl(callbackUrl)

  return { request: decodeAppConnectRequest(requestBytes), requestBytes, network, callbackUrl }
}

/**
 * The wallet's freshness rule: `stale` when created more than 10 minutes
 * before `now`, `future` when more than 2 minutes after it.
 */
export function checkAppConnectRequestAge(createdAt: number, now: number): 'stale' | 'future' | null {
  if (now - createdAt > APP_CONNECT_MAX_REQUEST_AGE_MS) return 'stale'
  if (createdAt - now > APP_CONNECT_MAX_REQUEST_SKEW_MS) return 'future'
  return null
}
