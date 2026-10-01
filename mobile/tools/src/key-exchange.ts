/**
 * The wallet side of the `dash-key:` key exchange, with no network access.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md ("Dash Platform Application Key Exchange
 * Protocol") §5.1 (login key), §6 (ECDH and AES-GCM) and §9 (response
 * document). The app side is `vendor/platform-auth/src/key-exchange/
 * yappr-protocol.ts`, which this module reuses for the URI codec, `hash160`
 * and the shared-secret KDF so both ends cannot drift apart.
 *
 * One departure from a real wallet, by necessity: a wallet takes the HKDF input
 * key from BIP32 (`m/9'/coin'/21'/account'`), and the sakura pool holds no
 * seed, only identity keys. The responder uses the persona's AUTHENTICATION /
 * CRITICAL private key (keyId 1) as that input key instead. Everything after
 * it is the spec's derivation, so the result is deterministic per (identity,
 * app contract, keyIndex), and a re-login yields the same login key.
 *
 * Per-call key copies are not wiped: the whole pool stays in memory for the
 * life of the process anyway.
 */
import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  deriveYapprSharedSecret,
  hash160,
  type YapprKeyExchangeRequest,
} from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'

/** The `loginKeyResponse` fields the wallet writes (key-exchange-v2). */
export interface LoginKeyResponseFields {
  contractId: Uint8Array
  appEphemeralPubKeyHash: Uint8Array
  walletEphemeralPubKey: Uint8Array
  encryptedPayload: Uint8Array
  keyIndex: number
}

export interface AnswerKeyExchangeInput {
  request: YapprKeyExchangeRequest
  /** The answering identity's id, raw 32 bytes. */
  identityId: Uint8Array
  /** The HKDF input key: the persona's CRITICAL auth private key (32 bytes). */
  baseKey: Uint8Array
  keyIndex: number
}

const MAX_KEY_INDEX = 0xffffffff

/**
 * `login_key = HKDF-SHA256(ikm = baseKey, salt = identityId,
 *  info = contractId || u32le(keyIndex), length = 32)` (spec §5.1 step 2).
 * An out-of-range scalar re-derives with a one-byte counter appended to
 * `info`, from 1 up to 255.
 */
export function deriveLoginKey(
  baseKey: Uint8Array,
  identityId: Uint8Array,
  contractId: Uint8Array,
  keyIndex: number,
): Uint8Array {
  requireLength(baseKey, 32, 'base key')
  requireLength(identityId, 32, 'identity id')
  requireLength(contractId, 32, 'contract id')
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > MAX_KEY_INDEX) {
    throw new Error(`keyIndex must be a u32, got ${keyIndex}`)
  }

  const info = new Uint8Array(36)
  info.set(contractId, 0)
  new DataView(info.buffer).setUint32(32, keyIndex, true)

  for (let counter = 0; counter <= 0xff; counter++) {
    const attemptInfo = counter === 0 ? info : concatBytes(info, Uint8Array.of(counter))
    const candidate = hkdf(sha256, baseKey, identityId, attemptInfo, 32)
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate
  }
  throw new Error('login key derivation exhausted its retry counter')
}

/** AES-256-GCM with a random nonce: `nonce(12) || ciphertext || tag(16)` (spec §6.4). */
async function encryptLoginKey(loginKey: Uint8Array, sharedSecret: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(sharedSecret), { name: 'AES-GCM' }, false, ['encrypt'])
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, toArrayBuffer(loginKey))
  return concatBytes(nonce, new Uint8Array(sealed))
}

/**
 * Builds the response a wallet publishes for `request`: derive the login key,
 * ECDH with a fresh wallet ephemeral key, encrypt.
 */
export async function answerKeyExchange(input: AnswerKeyExchangeInput): Promise<LoginKeyResponseFields> {
  const { request, identityId, baseKey, keyIndex } = input
  requireLength(request.appEphemeralPubKey, 33, 'app ephemeral public key')
  requireLength(request.contractId, 32, 'app contract id')

  const walletEphemeralPrivateKey = secp256k1.utils.randomSecretKey()
  const loginKey = deriveLoginKey(baseKey, identityId, request.contractId, keyIndex)
  // The KDF is symmetric in its two keys: wallet private × app public gives
  // the point the app gets from app private × wallet public.
  const sharedSecret = deriveYapprSharedSecret(walletEphemeralPrivateKey, request.appEphemeralPubKey)
  return {
    contractId: request.contractId,
    appEphemeralPubKeyHash: hash160(request.appEphemeralPubKey),
    walletEphemeralPubKey: secp256k1.getPublicKey(walletEphemeralPrivateKey, true),
    encryptedPayload: await encryptLoginKey(loginKey, sharedSecret),
    keyIndex,
  }
}

function requireLength(bytes: Uint8Array, length: number, label: string): void {
  if (bytes.length !== length) {
    throw new Error(`Invalid ${label} length: expected ${length}, got ${bytes.length}`)
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
