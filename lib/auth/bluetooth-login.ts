/**
 * Bluetooth LE sign-in: receive a bounded login key from a phone.
 *
 * The phone (the Dash wallet) is the GATT peripheral, the browser the
 * central. The phone advertises `BLUETOOTH_LOGIN_SERVICE_UUID` with three
 * characteristics:
 *
 * - request (write): the browser writes one request, which is the
 *   `dash-key:` request body with a network byte after the version.
 * - status (read + notify): one byte, see `BluetoothLoginStatus`.
 * - response (read): once the status is `ready`, the encrypted login key
 *   with the id and limits of the identity key the phone registered.
 *
 * The envelope is the same one the QR key-exchange flow decrypts
 * (`decryptYapprKeyExchangeResponse`): ECDH against the browser's
 * ephemeral key, HKDF with the `dash:key-exchange:v1` salt, AES-GCM over
 * the 32-byte login key. The phone registers
 * `ECDSA_HASH160(deriveYapprAuthKeyFromLogin(loginKey))` as an
 * AUTHENTICATION / HIGH key carrying the budget and expiry the user chose
 * on the phone, so the browser then signs in exactly as after a QR login.
 *
 * The pure helpers (request encoding, response decoding, pairing code)
 * live here so they can be unit-tested; the GATT transport is below them
 * and only runs in a browser with Web Bluetooth.
 */

/// <reference types="web-bluetooth" />

import bs58 from 'bs58'
import {
  hash160,
  serializeYapprKeyExchangeRequest,
  YAPPR_KEY_EXCHANGE_VERSION,
  YAPPR_NETWORK_IDS,
  type YapprKeyExchangeRequest,
} from 'platform-auth'
import type { AppNetwork } from '@/lib/constants'

export const BLUETOOTH_LOGIN_SERVICE_UUID = '8f9a3e10-5c2b-4d6e-9f1a-2b3c4d5e6f01'
export const BLUETOOTH_LOGIN_REQUEST_UUID = '8f9a3e10-5c2b-4d6e-9f1a-2b3c4d5e6f02'
export const BLUETOOTH_LOGIN_STATUS_UUID = '8f9a3e10-5c2b-4d6e-9f1a-2b3c4d5e6f03'
export const BLUETOOTH_LOGIN_RESPONSE_UUID = '8f9a3e10-5c2b-4d6e-9f1a-2b3c4d5e6f04'

/** Value of the phone's status characteristic. */
export enum BluetoothLoginStatus {
  Idle = 0,
  AwaitingConfirmation = 1,
  Registering = 2,
  Ready = 3,
  Rejected = 4,
  Failed = 5,
}

/** Size of the fixed-layout response the phone serves. */
export const BLUETOOTH_LOGIN_RESPONSE_LENGTH = 1 + 32 + 33 + 60 + 4 + 8 + 8

export interface BluetoothLoginResponse {
  /** Owner of the registered key, base58. */
  identityId: string
  identityIdBytes: Uint8Array
  /** Compressed secp256k1 point for the ECDH. */
  walletEphemeralPubKey: Uint8Array
  /** nonce(12) || ciphertext(32) || tag(16) */
  encryptedPayload: Uint8Array
  /** Id of the identity key the phone registered. */
  keyId: number
  /** Block time in ms from which the key can no longer sign, if limited. */
  expiresAt: number | null
  /** Lifetime spend cap in credits, if limited. */
  totalBudget: bigint | null
}

/** True when this browser can act as a Web Bluetooth central. */
export function isBluetoothLoginSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth
}

/**
 * The bytes written to the request characteristic:
 *
 *     version(1) || network(1) || appEphemeralPubKey(33) || contractId(32) || labelLen(1) || label
 *
 * That is the `dash-key:` request body with the network byte the URI
 * carries in its `n=` parameter spliced in after the version, so the
 * phone can refuse a request for another chain before showing anything.
 */
export function buildBluetoothLoginRequest(request: YapprKeyExchangeRequest, network: AppNetwork): Uint8Array {
  const body = serializeYapprKeyExchangeRequest(request)
  const out = new Uint8Array(body.length + 1)
  out[0] = YAPPR_KEY_EXCHANGE_VERSION
  out[1] = YAPPR_NETWORK_IDS[network].charCodeAt(0)
  out.set(body.subarray(1), 2)
  return out
}

/**
 * Six digits derived from the browser's ephemeral public key. The phone
 * shows the same six, and the user only confirms on the phone when they
 * match, which rules out another radio in range answering the request.
 */
export function bluetoothPairingCode(appEphemeralPubKey: Uint8Array): string {
  const digest = hash160(appEphemeralPubKey)
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  return String(value % 1_000_000).padStart(6, '0')
}

/**
 * Decode the phone's response:
 *
 *     version(1) || identityId(32) || walletEphemeralPubKey(33) || encryptedPayload(60)
 *     || keyId(4 BE) || expiresAt(8 BE, 0 = none) || totalBudget(8 BE, 0 = none)
 */
export function parseBluetoothLoginResponse(bytes: Uint8Array): BluetoothLoginResponse {
  if (bytes.length !== BLUETOOTH_LOGIN_RESPONSE_LENGTH) {
    throw new Error(`Unexpected Bluetooth login response length: expected ${BLUETOOTH_LOGIN_RESPONSE_LENGTH}, got ${bytes.length}`)
  }
  if (bytes[0] !== YAPPR_KEY_EXCHANGE_VERSION) {
    throw new Error(`Unsupported Bluetooth login response version ${bytes[0]}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 1
  const identityIdBytes = bytes.slice(offset, offset + 32)
  offset += 32
  const walletEphemeralPubKey = bytes.slice(offset, offset + 33)
  offset += 33
  const encryptedPayload = bytes.slice(offset, offset + 60)
  offset += 60
  const keyId = view.getUint32(offset)
  offset += 4
  const expiresAt = view.getBigUint64(offset)
  offset += 8
  const totalBudget = view.getBigUint64(offset)

  return {
    identityId: bs58.encode(identityIdBytes),
    identityIdBytes,
    walletEphemeralPubKey,
    encryptedPayload,
    keyId,
    expiresAt: expiresAt === 0n ? null : Number(expiresAt),
    totalBudget: totalBudget === 0n ? null : totalBudget,
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class BluetoothLoginError extends Error {
  constructor(message: string, readonly status?: BluetoothLoginStatus) {
    super(message)
    this.name = 'BluetoothLoginError'
  }
}

export interface BluetoothExchangeOptions {
  signal?: AbortSignal
  /** Called with each status byte the phone reports. */
  onStatus?: (status: BluetoothLoginStatus) => void
  /** How long to wait for the phone to reach `ready`. Default 5 minutes. */
  timeoutMs?: number
  /** How often to re-read the status if notifications go missing. Default 2 s. */
  pollIntervalMs?: number
}

/**
 * Show the browser's device chooser filtered to phones advertising the
 * login service. Must run inside a user gesture (a click handler).
 */
export async function requestBluetoothWallet(): Promise<BluetoothDevice> {
  if (!isBluetoothLoginSupported()) {
    throw new BluetoothLoginError('This browser cannot use Bluetooth. Try Chrome or Edge on a computer or Android.')
  }
  try {
    return await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLUETOOTH_LOGIN_SERVICE_UUID] }],
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      throw new BluetoothLoginError('No phone was chosen.')
    }
    throw err
  }
}

/**
 * Connect to the chosen phone, hand it the request, wait for the user to
 * confirm on the phone and for the key to be registered, then return the
 * raw response bytes. The connection is closed before returning.
 */
export async function exchangeLoginKeyOverBluetooth(
  device: BluetoothDevice,
  requestBytes: Uint8Array,
  options: BluetoothExchangeOptions = {},
): Promise<Uint8Array> {
  const { signal, onStatus, timeoutMs = 5 * 60_000, pollIntervalMs = 2_000 } = options
  if (!device.gatt) {
    throw new BluetoothLoginError('The chosen device has no GATT server.')
  }

  const server = await device.gatt.connect()
  try {
    throwIfAborted(signal)
    const service = await server.getPrimaryService(BLUETOOTH_LOGIN_SERVICE_UUID)
    const [requestChar, statusChar, responseChar] = await Promise.all([
      service.getCharacteristic(BLUETOOTH_LOGIN_REQUEST_UUID),
      service.getCharacteristic(BLUETOOTH_LOGIN_STATUS_UUID),
      service.getCharacteristic(BLUETOOTH_LOGIN_RESPONSE_UUID),
    ])

    const terminal = await new Promise<BluetoothLoginStatus>((resolve, reject) => {
      let settled = false
      let lastReported: BluetoothLoginStatus | null = null

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poller)
        statusChar.removeEventListener('characteristicvaluechanged', onChanged)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const report = (status: BluetoothLoginStatus) => {
        if (status !== lastReported) {
          lastReported = status
          onStatus?.(status)
        }
        switch (status) {
          case BluetoothLoginStatus.Ready:
            finish(() => resolve(status))
            break
          case BluetoothLoginStatus.Rejected:
            finish(() => reject(new BluetoothLoginError('The request was declined on the phone.', status)))
            break
          case BluetoothLoginStatus.Failed:
            finish(() => reject(new BluetoothLoginError('The phone could not register the key.', status)))
            break
          default:
            break
        }
      }

      const onChanged = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value
        if (value && value.byteLength >= 1) report(value.getUint8(0))
      }
      const onAbort = () => finish(() => reject(new BluetoothLoginError('Cancelled')))

      const timer = setTimeout(() => {
        finish(() => reject(new BluetoothLoginError('The phone did not answer in time.')))
      }, timeoutMs)

      // Notifications are the fast path; a periodic read covers a phone
      // whose notification was sent before the subscription landed.
      const poller = setInterval(() => {
        statusChar.readValue()
          .then((value) => { if (value.byteLength >= 1) report(value.getUint8(0)) })
          .catch(() => { /* a dropped link surfaces through the next step */ })
      }, pollIntervalMs)

      statusChar.addEventListener('characteristicvaluechanged', onChanged)
      signal?.addEventListener('abort', onAbort)

      statusChar.startNotifications()
        .then(() => requestChar.writeValueWithResponse(toArrayBuffer(requestBytes)))
        .then(() => statusChar.readValue())
        .then((value) => { if (value.byteLength >= 1) report(value.getUint8(0)) })
        .catch((err) => finish(() => reject(err)))
    })

    if (terminal !== BluetoothLoginStatus.Ready) {
      throw new BluetoothLoginError('The phone did not deliver a key.', terminal)
    }
    const response = await responseChar.readValue()
    return new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
  } finally {
    if (server.connected) server.disconnect()
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BluetoothLoginError('Cancelled')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
