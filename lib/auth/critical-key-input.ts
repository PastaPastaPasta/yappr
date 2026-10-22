/**
 * What the step-up sheet (components/auth/critical-key-sheet.tsx) accepts:
 * the account's CRITICAL private key (WIF or hex), or its recovery phrase,
 * from which the key is derived (DIP-13, as the wallet holding the phrase
 * derives it). Either way the result is checked against the identity's
 * enabled CRITICAL authentication key before anything signs with it. The
 * phrase is only read here: never stored, logged or sent.
 */
import { checkCriticalKey } from './login-key'
import { criticalKey, phraseKeys } from './recovery-phrase'
import { identityAuthKeyPath, normalizeRecoveryPhrase, type Dip13Wallet } from '@/lib/crypto/dip13'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { toKeyInfo, type IdentityKeyLike } from '@/lib/crypto/keys'
import { hexToBytes, isLikelyHex, privateKeyToWif } from '@/lib/crypto/wif'

/** How many of a phrase's identities (identity index 0, 1, ...) are searched for the account's key. */
const PHRASE_IDENTITY_INDEXES = 32

/** Twelve words or more is a recovery phrase; anything shorter is read as a private key. */
export function looksLikeRecoveryPhrase(input: string): boolean {
  return normalizeRecoveryPhrase(input).split(' ').length >= 12
}

export type CriticalKeyInput =
  | { ok: true; wif: string }
  | { ok: false; error: string }

export const PHRASE_HOLDS_NO_CRITICAL_KEY = 'This recovery phrase doesn\'t hold this account\'s highest-security key.'

/** A pasted private key, WIF or hex, checked against the identity's enabled CRITICAL authentication key. */
export function criticalKeyFromPrivateKey(input: string, publicKeys: readonly IdentityKeyLike[], network: 'testnet' | 'mainnet'): CriticalKeyInput {
  const trimmed = input.trim()
  let wif = trimmed
  if (isLikelyHex(trimmed)) {
    const bytes = hexToBytes(trimmed)
    wif = privateKeyToWif(bytes, network, true)
    bytes.fill(0)
  }
  const check = checkCriticalKey(wif, publicKeys, network)
  return check.isValid ? { ok: true, wif } : { ok: false, error: check.error ?? 'This key doesn\'t belong to this account.' }
}

/**
 * The identity's enabled CRITICAL authentication key as `wallet` derives it
 * (key index = key id, as wallets register them), searching the phrase's
 * first identities. Null when the phrase holds none. Derived bytes are wiped.
 */
export function criticalKeyFromPhrase(wallet: Dip13Wallet, publicKeys: readonly IdentityKeyLike[], network: 'testnet' | 'mainnet'): CriticalKeyInput {
  const candidates = publicKeys.filter((key) => {
    const info = toKeyInfo(key)
    return !key.disabledAt && info?.purpose === KeyPurpose.AUTHENTICATION && info.securityLevel === SecurityLevel.CRITICAL
  })
  if (candidates.length === 0) return { ok: false, error: PHRASE_HOLDS_NO_CRITICAL_KEY }
  for (let identityIndex = 0; identityIndex < PHRASE_IDENTITY_INDEXES; identityIndex++) {
    const held = phraseKeys(candidates, (keyIndex) => wallet.derive(identityAuthKeyPath(network, identityIndex, keyIndex)))
    try {
      const found = criticalKey(held)
      if (found) return { ok: true, wif: privateKeyToWif(found.privateKey, network, true) }
    } finally {
      for (const key of held) key.privateKey.fill(0)
    }
  }
  return { ok: false, error: PHRASE_HOLDS_NO_CRITICAL_KEY }
}
