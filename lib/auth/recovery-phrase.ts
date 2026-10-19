/**
 * The pure rules of recovery-phrase sign-in (D38): which of an identity's
 * keys a phrase holds, which one signs the session, and where the phrase's
 * messaging key stands against the identity's. They follow the reference
 * wallet (dashwallet-ios #1210, `AppConnectV2Login.encryptionKeyState`) so a
 * phrase typed here and the same phrase in a wallet treat an account alike.
 */
import { bytesEqual, normalizeBytes } from '@/lib/bytes'
import { findAnchorEncryptionKey, type EncryptionKeyCandidate } from '@/lib/crypto/encryption-key-lookup'
import { hash160 } from '@/lib/crypto/hash'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { toKeyInfo, type IdentityKeyLike } from '@/lib/crypto/keys'
import type { Dip13Key } from '@/lib/crypto/dip13'

/** An enabled identity key whose private half the phrase derives (at key index = key id, as wallets register them). */
export interface PhraseKey {
  id: number
  purpose: number
  securityLevel: number
  privateKey: Uint8Array
}

function holds(key: Dip13Key, type: number, data: Uint8Array): boolean {
  if (type === KeyType.ECDSA_SECP256K1) return bytesEqual(data, key.publicKey)
  if (type === KeyType.ECDSA_HASH160) return bytesEqual(data, hash160(key.publicKey))
  return false
}

/**
 * The enabled keys of `keys` that `deriveAt(keyId)` reproduces. A key the
 * phrase does not hold is skipped, never guessed (rs-platform-wallet
 * `derive_key_breadcrumbs` verifies each key the same way).
 */
export function phraseKeys(keys: readonly IdentityKeyLike[], deriveAt: (keyIndex: number) => Dip13Key): PhraseKey[] {
  const held: PhraseKey[] = []
  for (const key of keys) {
    if (key.disabledAt) continue
    const info = toKeyInfo(key)
    if (!info || info.id < 0 || info.id >= 0x80000000) continue
    const derived = deriveAt(info.id)
    if (holds(derived, info.type, info.data)) {
      held.push({ id: info.id, purpose: info.purpose, securityLevel: info.securityLevel, privateKey: derived.privateKey })
    } else {
      derived.privateKey.fill(0)
    }
  }
  return held
}

const authenticationAt = (keys: readonly PhraseKey[], level: number) =>
  keys.find((key) => key.purpose === KeyPurpose.AUTHENTICATION && key.securityLevel === level)

/**
 * The key a phrase session signs with: its HIGH authentication key, kept like
 * a HIGH key typed in by hand; else its CRITICAL one, which (also as typed)
 * stays in the tab. Never MASTER, which only adds the messaging key.
 */
export function sessionKey(keys: readonly PhraseKey[]): PhraseKey | undefined {
  return authenticationAt(keys, SecurityLevel.HIGH) ?? authenticationAt(keys, SecurityLevel.CRITICAL)
}

export function masterKey(keys: readonly PhraseKey[]): PhraseKey | undefined {
  return authenticationAt(keys, SecurityLevel.MASTER)
}

/** Where the phrase's messaging key stands (#1210 `EncryptionKeyState`). */
export type PhraseMessagingState = 'current' | 'absent' | 'another-wallet'

/**
 * `current` is the anchor's current key as `identities.contractKeys` reports
 * it (null for none); `identityKeys` the identity's keys, read fresh, whose
 * newest live anchor key stands in when that read finds none.
 * - current: the phrase's key is the current one: use it.
 * - absent: there is none, and the phrase's key was never on the identity: add it.
 * - another-wallet: another key is current or live, or the phrase's key was
 *   disabled. It is never replaced at sign-in: replacing it would orphan
 *   everything peers encrypted to it (a rotation, which only a wallet does, on request).
 */
export function phraseMessagingState(
  derivedPublicKey: Uint8Array,
  current: Uint8Array | null,
  identityKeys: readonly EncryptionKeyCandidate[],
  anchorId: string,
): PhraseMessagingState {
  const isPhraseKey = (candidate: EncryptionKeyCandidate): boolean => {
    const data = normalizeBytes(candidate.data)
    return data !== null && bytesEqual(data, derivedPublicKey)
  }
  if (current) return bytesEqual(current, derivedPublicKey) ? 'current' : 'another-wallet'
  // The current-key read can lag the identity: its newest live anchor key decides then, as in #1210.
  const newest = findAnchorEncryptionKey([...identityKeys], anchorId)
  if (newest) return isPhraseKey(newest) ? 'current' : 'another-wallet'
  return identityKeys.some(isPhraseKey) ? 'another-wallet' : 'absent'
}
