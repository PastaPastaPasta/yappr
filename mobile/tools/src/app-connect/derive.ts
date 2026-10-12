/**
 * Deterministic App Connect keys for a pool persona.
 *
 * A real wallet derives them from its seed at the profile's DIP-13 leaves
 * (docs/APP_CONNECT_PROFILE.md, wallet rules 6 and 7):
 *
 *   auth:       …/6'/0'/identityId'/hash256(appEphPub)'/bindingIndex'
 *   encryption: sub-feature 7' at (identity, appId, rotation)
 *
 * The sakura pool holds identity keys but no seed, so the responder keeps the
 * same inputs and replaces BIP32 with HKDF-SHA256 over the persona's
 * AUTHENTICATION/CRITICAL key (keyId 1), as the legacy responder does
 * (key-exchange.ts):
 *
 *   auth_i = HKDF(ikm = keyId 1, salt = identityId,
 *                 info = "yappr-test-wallet/app-connect/auth" ‖ hash256(appEphPub) ‖ u8(bindingIndex))
 *   enc    = HKDF(ikm = keyId 1, salt = identityId,
 *                 info = "yappr-test-wallet/app-connect/enc" ‖ appId ‖ u8(purpose) ‖ u32be(rotation))
 *
 * (a result that is not a valid secp256k1 scalar re-derives with a counter
 * byte 1..255 appended to info). Auth keys are fresh per request; the
 * encryption key is the same for every login of the persona to the app.
 */
import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()
const AUTH_INFO = encoder.encode('yappr-test-wallet/app-connect/auth')
const ENC_INFO = encoder.encode('yappr-test-wallet/app-connect/enc')

/** `hash256(appEphPub)`: the per-request derivation tag the grant record keeps for renewals. */
export function appConnectDerivationTag(appEphemeralPubKey: Uint8Array): Uint8Array {
  return sha256(sha256(appEphemeralPubKey))
}

export function deriveAppConnectAuthKey(
  baseKey: Uint8Array,
  identityId: Uint8Array,
  derivationTag: Uint8Array,
  bindingIndex: number,
): Uint8Array {
  requireLength(derivationTag, 32, 'derivation tag')
  if (!Number.isInteger(bindingIndex) || bindingIndex < 0 || bindingIndex > 0xff) {
    throw new Error(`binding index must be a byte, got ${bindingIndex}`)
  }
  return deriveScalar(baseKey, identityId, concatBytes(AUTH_INFO, derivationTag, Uint8Array.of(bindingIndex)))
}

export function deriveAppConnectEncryptionKey(
  baseKey: Uint8Array,
  identityId: Uint8Array,
  appId: Uint8Array,
  purpose: number,
  rotation: number,
): Uint8Array {
  requireLength(appId, 32, 'app id')
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 0xffffffff) {
    throw new Error(`rotation must be a u32, got ${rotation}`)
  }
  const tail = new Uint8Array(5)
  tail[0] = purpose
  new DataView(tail.buffer).setUint32(1, rotation)
  return deriveScalar(baseKey, identityId, concatBytes(ENC_INFO, appId, tail))
}

function deriveScalar(baseKey: Uint8Array, identityId: Uint8Array, info: Uint8Array): Uint8Array {
  requireLength(baseKey, 32, 'base key')
  requireLength(identityId, 32, 'identity id')
  for (let counter = 0; counter <= 0xff; counter++) {
    const attemptInfo = counter === 0 ? info : concatBytes(info, Uint8Array.of(counter))
    const candidate = hkdf(sha256, baseKey, identityId, attemptInfo, 32)
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate
  }
  throw new Error('key derivation exhausted its retry counter')
}

function requireLength(bytes: Uint8Array, length: number, label: string): void {
  if (bytes.length !== length) throw new Error(`Invalid ${label} length: expected ${length}, got ${bytes.length}`)
}
