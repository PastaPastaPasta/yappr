/**
 * A pool persona's App Connect keys (docs/APP_CONNECT_PROFILE.md, wallet rules 6 and 7).
 *
 * Seeded personas (the pool names a recovery phrase and the persona its DIP-13
 * identity index) derive exactly what the reference wallet derives
 * (dashwallet-ios #1210 through swift-sdk `deriveConnectKey`, rs-platform-wallet
 * `ConnectKey` and key-wallet), on the same wasm primitive as the web's
 * recovery-phrase sign-in (lib/crypto/dip13.ts):
 *
 *   encryption: m/9'/coin'/5'/7'/0'/identityId'/appId'/purpose'          (normative; rotation 0 only)
 *   auth i:     m/9'/coin'/5'/6'/0'/identityId'/hash256(appEphPub || u8(i))'   (#1210's leaf)
 *
 * Seedless personas (the sakura pool, and the testnet staging ledger whose keys
 * sit at a pre-DIP-13 path) keep the legacy scheme their on-chain keys were
 * made with, HKDF-SHA256 over the persona's AUTHENTICATION/CRITICAL key
 * (keyId 1), salt = identityId:
 *
 *   auth i:     info = "yappr-test-wallet/app-connect/auth" || hash256(appEphPub) || u8(i)
 *   enc:        info = "yappr-test-wallet/app-connect/enc" || appId || u8(purpose) || u32be(rotation)
 *
 * (a result that is not a valid secp256k1 scalar re-derives with a counter
 * byte 1..255 appended to info). No real wallet derives those, so a wallet
 * restoring a phrase never meets them.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { appEncryptionKeyPath, sessionAuthKeyPath, type AppKeyPurpose, type Dip13Network, type Dip13Wallet } from '../../../../lib/crypto/dip13'
import { hkdfSecretKey, requireLength } from '../key-exchange'

const encoder = new TextEncoder()
const AUTH_INFO = encoder.encode('yappr-test-wallet/app-connect/auth')
const ENC_INFO = encoder.encode('yappr-test-wallet/app-connect/enc')

/** `hash256(appEphPub)`: the per-request derivation tag the grant record keeps for renewals. */
export function appConnectDerivationTag(appEphemeralPubKey: Uint8Array): Uint8Array {
  return sha256(sha256(appEphemeralPubKey))
}

/** dashwallet-ios #1210 `authKeyLeaf`: `hash256(appEphPub || u8(bindingIndex))`. */
export function appConnectAuthKeyLeaf(appEphemeralPubKey: Uint8Array, bindingIndex: number): Uint8Array {
  requireByte(bindingIndex)
  return sha256(sha256(concatBytes(appEphemeralPubKey, Uint8Array.of(bindingIndex))))
}

function requireByte(bindingIndex: number): void {
  if (!Number.isInteger(bindingIndex) || bindingIndex < 0 || bindingIndex > 0xff) {
    throw new Error(`binding index must be a byte, got ${bindingIndex}`)
  }
}

/** What re-derives an auth key: the request's ephemeral key (seeded) or its tag (legacy; older grant records keep only that). */
export interface AuthKeySource {
  appEphemeralPubKey?: Uint8Array
  derivationTag: Uint8Array
}

export interface ConnectKeys {
  scheme: 'dip13' | 'legacy-hkdf'
  authKey(source: AuthKeySource, bindingIndex: number): Uint8Array
  /** The encryption keys this wallet holds for (app, purpose), rotation 0 first; DIP-13 holds rotation 0 only (#1210). */
  encryptionKeys(appId: Uint8Array, purpose: number, rotations: number): Uint8Array[]
}

/** DIP-13 keys from the pool's recovery phrase, at the persona's identity. */
export function dip13ConnectKeys(wallet: Dip13Wallet, network: Dip13Network, identityId: Uint8Array): ConnectKeys {
  return {
    scheme: 'dip13',
    authKey(source, bindingIndex) {
      if (!source.appEphemeralPubKey) throw new Error('this grant record predates the DIP-13 keys and cannot re-derive them')
      return wallet.derive(sessionAuthKeyPath(network, identityId, appConnectAuthKeyLeaf(source.appEphemeralPubKey, bindingIndex))).privateKey
    },
    encryptionKeys(appId, purpose) {
      requireLength(appId, 32, 'app id')
      return [wallet.derive(appEncryptionKeyPath(network, identityId, appId, purpose as AppKeyPurpose)).privateKey]
    },
  }
}

export function deriveAppConnectAuthKey(
  baseKey: Uint8Array,
  identityId: Uint8Array,
  derivationTag: Uint8Array,
  bindingIndex: number,
): Uint8Array {
  requireLength(derivationTag, 32, 'derivation tag')
  requireByte(bindingIndex)
  return hkdfSecretKey(baseKey, identityId, concatBytes(AUTH_INFO, derivationTag, Uint8Array.of(bindingIndex)))
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
  return hkdfSecretKey(baseKey, identityId, concatBytes(ENC_INFO, appId, tail))
}

/** The legacy scheme over a seedless persona's CRITICAL key; an operator may have registered later rotations. */
export function legacyConnectKeys(criticalKey: () => Uint8Array, identityId: Uint8Array): ConnectKeys {
  return {
    scheme: 'legacy-hkdf',
    authKey(source, bindingIndex) {
      return deriveAppConnectAuthKey(criticalKey(), identityId, source.derivationTag, bindingIndex)
    },
    encryptionKeys(appId, purpose, rotations) {
      return Array.from({ length: Math.max(1, rotations + 1) }, (_, rotation) =>
        deriveAppConnectEncryptionKey(criticalKey(), identityId, appId, purpose, rotation))
    },
  }
}
