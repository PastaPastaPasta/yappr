import * as secp256k1 from '@noble/secp256k1'
import { concatBytes } from '@noble/hashes/utils.js'
import { clearSensitiveBytes, deriveYapprSharedSecret, getYapprPublicKey, hash160 } from '../key-exchange/yappr-protocol'

/**
 * App Connect v2 response encryption:
 *
 *   key  = HKDF-SHA256(ECDH-x(appEph, walletEph), salt "dash:key-exchange:v1", info "app-connect:v2")
 *   aad  = "dash:app-connect:v2" ‖ hash160(appEphPub) ‖ $ownerId
 *   body = nonce(12) ‖ AES-256-GCM(key, nonce, aad, slot₀ ‖ … ‖ slotₙ₋₁) ‖ tag(16)
 *
 * Each slot is a 32-byte private key. The AAD ties the ciphertext to the
 * request and to the identity that publishes it, so a response copied under
 * another identity fails to open.
 */

export const APP_CONNECT_HKDF_INFO = 'app-connect:v2'
export const APP_CONNECT_AAD_PREFIX = 'dash:app-connect:v2'
export const APP_CONNECT_NONCE_BYTES = 12
export const APP_CONNECT_ENVELOPE_BYTES = APP_CONNECT_NONCE_BYTES + 16
export const APP_CONNECT_SLOT_BYTES = 32
/** The `loginKeyResponse` schema's limit (572-byte payload). */
export const APP_CONNECT_MAX_SLOTS = 17

const encoder = new TextEncoder()

export class AppConnectPayloadError extends Error {
  readonly code: 'framing' | 'decrypt'

  constructor(code: 'framing' | 'decrypt', message: string) {
    super(message)
    this.name = 'AppConnectPayloadError'
    this.code = code
  }
}

export function appConnectAad(appEphemeralPubKey: Uint8Array, ownerId: Uint8Array): Uint8Array {
  if (appEphemeralPubKey.length !== 33) throw new Error('app ephemeral public key must be 33 bytes')
  if (ownerId.length !== 32) throw new Error('owner id must be 32 bytes')
  return concatBytes(encoder.encode(APP_CONNECT_AAD_PREFIX), hash160(appEphemeralPubKey), ownerId)
}

/** Number of key slots a payload of this length holds, or null when the framing is wrong. */
export function appConnectSlotCount(payloadLength: number): number | null {
  const body = payloadLength - APP_CONNECT_ENVELOPE_BYTES
  if (body <= 0 || body % APP_CONNECT_SLOT_BYTES !== 0) return null
  const slots = body / APP_CONNECT_SLOT_BYTES
  return slots <= APP_CONNECT_MAX_SLOTS ? slots : null
}

function appConnectSessionKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return deriveYapprSharedSecret(privateKey, publicKey, encoder.encode(APP_CONNECT_HKDF_INFO))
}

async function importAesKey(rawKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, [usage])
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export interface SealAppConnectPayloadInput {
  appEphemeralPubKey: Uint8Array
  ownerId: Uint8Array
  slots: Uint8Array[]
  /** Fresh per response; fixed only for test vectors. */
  walletEphemeralPrivateKey?: Uint8Array
  /** Random by default; fixed only for test vectors. */
  nonce?: Uint8Array
}

/** Wallet side: encrypts the granted keys to the app's request. */
export async function sealAppConnectPayload(
  input: SealAppConnectPayloadInput,
): Promise<{ walletEphemeralPubKey: Uint8Array; encryptedPayload: Uint8Array }> {
  const { appEphemeralPubKey, ownerId, slots } = input
  if (slots.length < 1 || slots.length > APP_CONNECT_MAX_SLOTS) {
    throw new Error(`expected 1 to ${APP_CONNECT_MAX_SLOTS} slots, got ${slots.length}`)
  }
  if (slots.some((slot) => slot.length !== APP_CONNECT_SLOT_BYTES)) {
    throw new Error(`every slot must be ${APP_CONNECT_SLOT_BYTES} bytes`)
  }
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(APP_CONNECT_NONCE_BYTES))
  if (nonce.length !== APP_CONNECT_NONCE_BYTES) throw new Error(`nonce must be ${APP_CONNECT_NONCE_BYTES} bytes`)

  const walletEphemeralPrivateKey = input.walletEphemeralPrivateKey ?? secp256k1.utils.randomSecretKey()
  const walletEphemeralPubKey = getYapprPublicKey(walletEphemeralPrivateKey)
  const sessionKey = appConnectSessionKey(walletEphemeralPrivateKey, appEphemeralPubKey)
  const plaintext = new Uint8Array(slots.length * APP_CONNECT_SLOT_BYTES)
  slots.forEach((slot, index) => plaintext.set(slot, index * APP_CONNECT_SLOT_BYTES))

  try {
    const key = await importAesKey(sessionKey, 'encrypt')
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(appConnectAad(appEphemeralPubKey, ownerId)) },
      key,
      toArrayBuffer(plaintext),
    ))
    return { walletEphemeralPubKey, encryptedPayload: concatBytes(nonce, sealed) }
  } finally {
    clearSensitiveBytes(sessionKey)
    clearSensitiveBytes(plaintext)
    if (!input.walletEphemeralPrivateKey) clearSensitiveBytes(walletEphemeralPrivateKey)
  }
}

export interface OpenAppConnectPayloadInput {
  appEphemeralPrivateKey: Uint8Array
  ownerId: Uint8Array
  walletEphemeralPubKey: Uint8Array
  encryptedPayload: Uint8Array
}

/**
 * App side: checks the framing and the tag, and returns the slots in payload
 * order. The caller owns (and should clear) the returned keys. Throws
 * {@link AppConnectPayloadError}.
 */
export async function openAppConnectPayload(input: OpenAppConnectPayloadInput): Promise<Uint8Array[]> {
  const { encryptedPayload } = input
  const slotCount = appConnectSlotCount(encryptedPayload.length)
  if (slotCount === null) {
    throw new AppConnectPayloadError('framing', `payload of ${encryptedPayload.length} bytes is not 28 + 32n with 1 <= n <= ${APP_CONNECT_MAX_SLOTS}`)
  }

  let sessionKey: Uint8Array
  try {
    sessionKey = appConnectSessionKey(input.appEphemeralPrivateKey, input.walletEphemeralPubKey)
  } catch {
    throw new AppConnectPayloadError('decrypt', 'wallet ephemeral public key is not a valid point')
  }
  const appEphemeralPubKey = getYapprPublicKey(input.appEphemeralPrivateKey)

  let plaintext: Uint8Array
  try {
    const key = await importAesKey(sessionKey, 'decrypt')
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(encryptedPayload.subarray(0, APP_CONNECT_NONCE_BYTES)),
        additionalData: toArrayBuffer(appConnectAad(appEphemeralPubKey, input.ownerId)),
      },
      key,
      toArrayBuffer(encryptedPayload.subarray(APP_CONNECT_NONCE_BYTES)),
    ))
  } catch {
    throw new AppConnectPayloadError('decrypt', 'payload does not decrypt for this request and owner')
  } finally {
    clearSensitiveBytes(sessionKey)
  }

  const slots = Array.from({ length: slotCount }, (_, index) =>
    plaintext.slice(index * APP_CONNECT_SLOT_BYTES, (index + 1) * APP_CONNECT_SLOT_BYTES))
  clearSensitiveBytes(plaintext)
  return slots
}
