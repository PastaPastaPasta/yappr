import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type {
  PlatformAuthLogger,
  YapprDecryptedKeyExchangeResult,
  YapprKeyExchangeConfig,
  YapprKeyExchangeNetworkName,
  YapprKeyExchangePort,
  YapprKeyExchangeResponse,
} from '../core/types'

const encoder = new TextEncoder()

export const YAPPR_KEY_EXCHANGE_VERSION = 1
export const YAPPR_STATE_TRANSITION_VERSION = 1

export const YAPPR_NETWORK_IDS = {
  mainnet: 'm',
  testnet: 't',
  devnet: 'd',
} as const

export const DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG: Pick<YapprKeyExchangeConfig, 'label' | 'pollIntervalMs' | 'timeoutMs'> = {
  label: 'Login to Yappr',
  pollIntervalMs: 3000,
  timeoutMs: 120000,
}

export interface YapprKeyExchangeRequest {
  appEphemeralPubKey: Uint8Array
  contractId: Uint8Array
  label?: string
}

export interface YapprEphemeralKeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export interface PollForYapprKeyExchangeResponseOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  onPoll?: () => void
  logger?: PlatformAuthLogger
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

export function generateYapprEphemeralKeyPair(): YapprEphemeralKeyPair {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  return { privateKey, publicKey }
}

export function deriveYapprSharedSecret(
  appEphemeralPrivateKey: Uint8Array,
  walletEphemeralPublicKey: Uint8Array,
): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(appEphemeralPrivateKey, walletEphemeralPublicKey)
  const sharedX = sharedPoint.slice(1, 33)
  return hkdf(
    sha256,
    sharedX,
    encoder.encode('dash:key-exchange:v1'),
    new Uint8Array(0),
    32,
  )
}

export async function decryptYapprLoginKey(
  encryptedPayload: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<Uint8Array> {
  if (encryptedPayload.length < 60) {
    throw new Error('Encrypted payload too short; must be at least 60 bytes')
  }

  const nonce = encryptedPayload.slice(0, 12)
  const ciphertextWithTag = encryptedPayload.slice(12)

  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret.buffer.slice(sharedSecret.byteOffset, sharedSecret.byteOffset + sharedSecret.byteLength) as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertextWithTag,
  )

  const result = new Uint8Array(decrypted)
  if (result.length !== 32) {
    throw new Error(`Invalid decrypted login key length: expected 32, got ${result.length}`)
  }
  return result
}

export function deriveYapprAuthKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`)
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`)
  }

  return hkdf(
    sha256,
    loginKey,
    identityIdBytes,
    encoder.encode('auth'),
    32,
  )
}

export function deriveYapprEncryptionKeyFromLogin(loginKey: Uint8Array, identityIdBytes: Uint8Array): Uint8Array {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`)
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`)
  }

  return hkdf(
    sha256,
    loginKey,
    identityIdBytes,
    encoder.encode('encryption'),
    32,
  )
}

export function getYapprPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

export function clearSensitiveBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}

export function decodeYapprIdentityId(identityIdBase58: string): Uint8Array {
  const decoded = bs58.decode(identityIdBase58)
  if (decoded.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${decoded.length}`)
  }
  return decoded
}

export function decodeYapprContractId(contractIdBase58: string): Uint8Array {
  const decoded = bs58.decode(contractIdBase58)
  if (decoded.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${decoded.length}`)
  }
  return decoded
}

export function serializeYapprKeyExchangeRequest(request: YapprKeyExchangeRequest): Uint8Array {
  if (request.appEphemeralPubKey.length !== 33) {
    throw new Error(`Invalid ephemeral public key length: expected 33, got ${request.appEphemeralPubKey.length}`)
  }
  if (request.contractId.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${request.contractId.length}`)
  }

  const labelBytes = request.label ? encoder.encode(request.label) : new Uint8Array(0)
  if (labelBytes.length > 64) {
    throw new Error(`Label too long: max 64 bytes, got ${labelBytes.length}`)
  }

  const buffer = new Uint8Array(1 + 33 + 32 + 1 + labelBytes.length)
  let offset = 0
  buffer[offset++] = YAPPR_KEY_EXCHANGE_VERSION
  buffer.set(request.appEphemeralPubKey, offset)
  offset += 33
  buffer.set(request.contractId, offset)
  offset += 32
  buffer[offset++] = labelBytes.length
  if (labelBytes.length > 0) {
    buffer.set(labelBytes, offset)
  }
  return buffer
}

export function buildYapprKeyExchangeUri(
  request: YapprKeyExchangeRequest,
  network: YapprKeyExchangeNetworkName = 'testnet',
): string {
  const requestBytes = serializeYapprKeyExchangeRequest(request)
  const requestData = bs58.encode(requestBytes)
  return `dash-key:${requestData}?n=${YAPPR_NETWORK_IDS[network]}&v=${YAPPR_KEY_EXCHANGE_VERSION}`
}

export function parseYapprKeyExchangeUri(uri: string): {
  request: YapprKeyExchangeRequest
  network: YapprKeyExchangeNetworkName
  version: number
} | null {
  try {
    if (!uri.startsWith('dash-key:')) {
      return null
    }

    const uriWithoutScheme = uri.slice(9)
    const queryStart = uriWithoutScheme.indexOf('?')
    if (queryStart === -1) {
      return null
    }

    const requestData = uriWithoutScheme.slice(0, queryStart)
    const queryString = uriWithoutScheme.slice(queryStart + 1)
    const params = new URLSearchParams(queryString)
    const networkId = params.get('n')
    const versionStr = params.get('v')
    if (!networkId || !versionStr) {
      return null
    }

    const version = Number.parseInt(versionStr, 10)
    if (version !== YAPPR_KEY_EXCHANGE_VERSION) {
      return null
    }

    const network = parseYapprNetworkId(networkId)
    if (!network) {
      return null
    }

    const requestBytes = bs58.decode(requestData)
    if (requestBytes.length < 67) {
      return null
    }

    let offset = 0
    const byteVersion = requestBytes[offset++]
    if (byteVersion !== YAPPR_KEY_EXCHANGE_VERSION) {
      return null
    }

    const appEphemeralPubKey = requestBytes.slice(offset, offset + 33)
    offset += 33
    const contractId = requestBytes.slice(offset, offset + 32)
    offset += 32
    const labelLength = requestBytes[offset++]
    if (labelLength > 64 || offset + labelLength > requestBytes.length) {
      return null
    }

    let label: string | undefined
    if (labelLength > 0) {
      label = new TextDecoder().decode(requestBytes.slice(offset, offset + labelLength))
    }

    return {
      request: {
        appEphemeralPubKey,
        contractId,
        label,
      },
      network,
      version,
    }
  } catch {
    return null
  }
}

export function buildYapprStateTransitionUri(
  transitionBytes: Uint8Array,
  network: YapprKeyExchangeNetworkName = 'testnet',
): string {
  return `dash-st:${bs58.encode(transitionBytes)}?n=${YAPPR_NETWORK_IDS[network]}&v=${YAPPR_STATE_TRANSITION_VERSION}`
}

export function parseYapprStateTransitionUri(uri: string): {
  transitionBytes: Uint8Array
  network: YapprKeyExchangeNetworkName
  version: number
} | null {
  try {
    if (!uri.startsWith('dash-st:')) {
      return null
    }

    const uriWithoutScheme = uri.slice(8)
    const queryStart = uriWithoutScheme.indexOf('?')
    if (queryStart === -1) {
      return null
    }

    const transitionData = uriWithoutScheme.slice(0, queryStart)
    const queryString = uriWithoutScheme.slice(queryStart + 1)
    const params = new URLSearchParams(queryString)
    const networkId = params.get('n')
    const versionStr = params.get('v')
    if (!networkId || !versionStr) {
      return null
    }

    const version = Number.parseInt(versionStr, 10)
    if (version !== YAPPR_STATE_TRANSITION_VERSION) {
      return null
    }

    const network = parseYapprNetworkId(networkId)
    if (!network) {
      return null
    }

    return {
      transitionBytes: bs58.decode(transitionData),
      network,
      version,
    }
  } catch {
    return null
  }
}

export async function pollForYapprKeyExchangeResponse(
  port: YapprKeyExchangePort,
  contractIdBytes: Uint8Array,
  appEphemeralPubKeyHash: Uint8Array,
  appEphemeralPrivateKey: Uint8Array,
  options: PollForYapprKeyExchangeResponseOptions = {},
): Promise<YapprDecryptedKeyExchangeResult> {
  const {
    pollIntervalMs = DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs,
    timeoutMs = DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs,
    signal,
    onPoll,
    logger,
  } = options

  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw new Error('Cancelled')
    }

    onPoll?.()

    try {
      const response = await port.getResponse(contractIdBytes, appEphemeralPubKeyHash)
      logger?.info('platform-auth: yappr key exchange poll result', {
        hasResponse: !!response,
        ownerId: response?.$ownerId,
      })

      if (response) {
        return await decryptYapprKeyExchangeResponse(response, appEphemeralPrivateKey)
      }
    } catch (error) {
      logger?.warn('platform-auth: yappr key exchange poll query failed', error)
    }

    await sleep(pollIntervalMs, signal)
  }

  throw new Error('Timeout waiting for key exchange response')
}

export async function decryptYapprKeyExchangeResponse(
  response: YapprKeyExchangeResponse,
  appEphemeralPrivateKey: Uint8Array,
): Promise<YapprDecryptedKeyExchangeResult> {
  const sharedSecret = deriveYapprSharedSecret(appEphemeralPrivateKey, response.walletEphemeralPubKey)

  try {
    const loginKey = await decryptYapprLoginKey(response.encryptedPayload, sharedSecret)
    return {
      loginKey,
      keyIndex: response.keyIndex,
      walletEphemeralPubKey: response.walletEphemeralPubKey,
      identityId: response.$ownerId,
    }
  } finally {
    clearSensitiveBytes(sharedSecret)
  }
}

function parseYapprNetworkId(networkId: string): YapprKeyExchangeNetworkName | null {
  switch (networkId) {
    case 'm':
      return 'mainnet'
    case 't':
      return 'testnet'
    case 'd':
      return 'devnet'
    default:
      return null
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'))
      return
    }

    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Cancelled'))
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort)
  })
}
