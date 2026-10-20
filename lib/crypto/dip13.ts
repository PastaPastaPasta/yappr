/**
 * DIP-13 identity keys from a recovery phrase, derived the way the reference
 * wallet does (dashwallet-ios #1210 -> swift-sdk `deriveConnectKey` ->
 * rs-platform-wallet `ConnectKey` -> rust-dashcore key-wallet `dip9.rs`):
 *
 *   identity auth key:   m/9'/coin'/5'/0'/0'/identity_index'/key_index'
 *   app encryption key:  m/9'/coin'/5'/7'/0'/identity_id'/contract_id'/purpose'
 *
 * `identity_id'` and `contract_id'` are DIP-14 256-bit hardened children, so
 * the derivation runs on wasm-sdk's `deriveKeyFromSeedWithExtendedPath`
 * (key-wallet's own BIP-32), which the pinned vectors in dip13.test.ts check
 * byte for byte. coin is 5' on mainnet and 1' elsewhere. The encryption key is
 * normative (docs/APP_CONNECT_PROFILE.md section 7): peers and every wallet holding the
 * phrase must find the same key, so nothing here may change without new vectors.
 *
 * No `@/` imports: the test wallet (mobile/tools) imports this file directly.
 */

export type Dip13Network = 'mainnet' | 'testnet'

/** DIP-13 `key_purpose'` of the application encryption sub-feature. */
export const APP_KEY_PURPOSE = { ENCRYPTION: 1, DECRYPTION: 2 } as const
export type AppKeyPurpose = (typeof APP_KEY_PURPOSE)[keyof typeof APP_KEY_PURPOSE]

/** Consecutive unused identity indexes after which discovery stops (rs-platform-wallet `IDENTITY_GAP_LIMIT`). */
export const IDENTITY_GAP_LIMIT = 5

/** Key index 0 of every wallet identity is its MASTER authentication key, the one discovery probes. */
export const MASTER_KEY_INDEX = 0

const coinType = (network: Dip13Network): number => (network === 'mainnet' ? 5 : 1)

function hardened(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error(`Invalid derivation index ${index}`)
  return `${index}'`
}

function hardened256(id: Uint8Array): string {
  if (id.length !== 32) throw new Error(`A 256-bit index needs 32 bytes, got ${id.length}`)
  let hex = ''
  for (const byte of id) hex += byte.toString(16).padStart(2, '0')
  return `0x${hex}'`
}

/** `m/9'/coin'/5'/0'/0'/identity_index'/key_index'`: an ECDSA identity authentication key. */
export function identityAuthKeyPath(network: Dip13Network, identityIndex: number, keyIndex: number): string {
  return `m/9'/${coinType(network)}'/5'/0'/0'/${hardened(identityIndex)}/${hardened(keyIndex)}`
}

/** `m/9'/coin'/5'/7'/0'/identity_id'/contract_id'/purpose'`: one half of an identity's encryption pair for a contract. */
export function appEncryptionKeyPath(
  network: Dip13Network,
  identityId: Uint8Array,
  contractId: Uint8Array,
  purpose: AppKeyPurpose = APP_KEY_PURPOSE.ENCRYPTION,
): string {
  return `m/9'/${coinType(network)}'/5'/7'/0'/${hardened256(identityId)}/${hardened256(contractId)}/${hardened(purpose)}`
}

/** `m/9'/coin'/5'/6'/0'/identity_id'/request_id'`: an App Connect session authentication key (non-normative use). */
export function sessionAuthKeyPath(network: Dip13Network, identityId: Uint8Array, requestId: Uint8Array): string {
  return `m/9'/${coinType(network)}'/5'/6'/0'/${hardened256(identityId)}/${hardened256(requestId)}`
}

/** A recovery phrase as BIP-39 reads it: lower case, single spaces, no padding. */
export function normalizeRecoveryPhrase(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

export interface Dip13Key {
  privateKey: Uint8Array
  /** 33-byte compressed secp256k1 point. */
  publicKey: Uint8Array
}

/** The wasm-sdk statics the derivation runs on (`WasmSdk` from `@dashevo/evo-sdk`, once initialised). */
export interface Dip13Wasm {
  validateMnemonic(mnemonic: string, languageCode?: string | null): boolean
  deriveKeyFromSeedWithExtendedPath(params: { mnemonic: string; path: string; network: string }): { toJSON(): unknown; free?: () => void }
}

async function wasm(): Promise<Dip13Wasm> {
  const { WasmSdk, ensureInitialized } = await import('@dashevo/evo-sdk')
  await ensureInitialized()
  return WasmSdk
}

function fromHex(hex: unknown, length: number, what: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length !== length * 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`The derivation returned no ${what}`)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** The phrase is not a BIP-39 English phrase with a valid checksum (as opposed to the SDK failing to load). */
export class InvalidPhraseError extends Error {
  constructor() {
    super('Invalid recovery phrase')
  }
}

/**
 * A key-deriving handle for one phrase (empty BIP-39 passphrase, as DashPay
 * uses). The phrase stays inside the closure; callers drop the handle when
 * done. Every key comes back as fresh bytes the caller may wipe. Wiping is
 * best effort: the SDK hands keys over as hex strings, and JS strings (the
 * phrase among them) cannot be zeroed.
 */
export interface Dip13Wallet {
  derive(path: string): Dip13Key
}

export async function openDip13Wallet(phrase: string, network: Dip13Network): Promise<Dip13Wallet> {
  return dip13Wallet(await wasm(), phrase, network)
}

/** {@link openDip13Wallet} on statics the caller already initialised (the test wallet, whose derivations are synchronous). */
export function dip13Wallet(sdk: Dip13Wasm, phrase: string, network: Dip13Network): Dip13Wallet {
  if (!sdk.validateMnemonic(phrase, 'en')) throw new InvalidPhraseError()
  return {
    derive(path) {
      const result = sdk.deriveKeyFromSeedWithExtendedPath({ mnemonic: phrase, path, network })
      try {
        const info = result.toJSON() as { privateKeyHex?: unknown; publicKey?: unknown }
        return { privateKey: fromHex(info.privateKeyHex, 32, 'private key'), publicKey: fromHex(info.publicKey, 33, 'public key') }
      } finally {
        result.free?.()
      }
    },
  }
}
