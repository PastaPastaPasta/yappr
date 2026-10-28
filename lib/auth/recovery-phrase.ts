/**
 * The pure rules of recovery-phrase sign-in (D38): which of an identity's
 * keys a phrase holds, which one signs the session, and where the phrase's
 * messaging key stands against the identity's. They follow the reference
 * wallet (dashwallet-ios #1210, `AppConnectV2Login.encryptionKeyState`) so a
 * phrase typed here and the same phrase in a wallet treat an account alike.
 */
import { bytesEqual, normalizeBytes } from '@/lib/bytes'
import { findAnchorEncryptionKey, isBoundToContract, type EncryptionKeyCandidate } from '@/lib/crypto/encryption-key-lookup'
import { hash160 } from '@/lib/crypto/hash'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { toKeyInfo, type IdentityKeyLike } from '@/lib/crypto/keys'
import type { Dip13Key } from '@/lib/crypto/dip13'

/**
 * Whether recovery-phrase sign-in is offered on `network`. Not on mainnet
 * yet: a phrase there controls real funds, and the app's CSP still allows
 * inline scripts (app/layout.tsx), so an injected script could read it as it
 * is typed. Wallet sign-in stays the way in there until that is tightened.
 */
export function recoveryPhraseOffered(network: string): boolean {
  return network !== 'mainnet'
}

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

/** The phrase's CRITICAL authentication key: what moderation and token transitions sign with (lib/auth/critical-key.ts). */
export function criticalKey(keys: readonly PhraseKey[]): PhraseKey | undefined {
  return authenticationAt(keys, SecurityLevel.CRITICAL)
}

export function masterKey(keys: readonly PhraseKey[]): PhraseKey | undefined {
  return authenticationAt(keys, SecurityLevel.MASTER)
}

/** Where the phrase's messaging key stands (#1210 `EncryptionKeyState`, DIP dashpay/dips#181 "Encryption Keys"). */
export type PhraseMessagingState = 'current' | 'absent' | 'another-wallet'

/**
 * Whether `publicKey` is an ENCRYPTION key bound to the anchor on the
 * identity, in any state. (The same point under another purpose or contract
 * is no anchor key.)
 */
function isAnchorKeyOnIdentity(publicKey: Uint8Array, identityKeys: readonly EncryptionKeyCandidate[], anchorId: string): boolean {
  return identityKeys.some((key) => {
    const data = normalizeBytes(key.data)
    return key.purpose === KeyPurpose.ENCRYPTION && isBoundToContract(key.contractBounds, anchorId) && data !== null && bytesEqual(data, publicKey)
  })
}

/**
 * Whether the identity has any ENCRYPTION key bound to the anchor, whoever's
 * and in any state (DIP "Encryption Keys", rule 2). With none of them
 * enabled, such a key still decides: under the anchor's requirement 0
 * Platform would refuse a second key, and under 2 a new key is a rotation,
 * which is the user's action in a wallet, never a login's.
 */
function hasAnchorEncryptionKeyInAnyState(identityKeys: readonly EncryptionKeyCandidate[], anchorId: string): boolean {
  return identityKeys.some((key) => key.purpose === KeyPurpose.ENCRYPTION && isBoundToContract(key.contractBounds, anchorId))
}

/**
 * The keys a phrase may hold as its messaging key for the anchor, in the
 * order the DIP finds them:
 *
 * 1. Rotation 0' at the DIP's 9-level path, always: it is the key a sign-in
 *    registers when there is none (index 0 of the result).
 * 2. Rotations 1', 2', ... at that path, each only while the one before is on
 *    the identity in any state (rotations are registered in order, so the
 *    first one that is not on the identity ends the scan).
 * 3. The pre-DIP key at the path without a rotation level (`deriveLegacy`;
 *    testnet and devnet wallets registered keys there), last, when asked for.
 *
 * Callers wipe every returned key's private bytes.
 */
export function messagingKeyCandidates(
  deriveRotation: (rotation: number) => Dip13Key,
  deriveLegacy: (() => Dip13Key) | null,
  identityKeys: readonly EncryptionKeyCandidate[],
  anchorId: string,
): Dip13Key[] {
  const keys = [deriveRotation(0)]
  for (let rotation = 0; isAnchorKeyOnIdentity(keys[rotation].publicKey, identityKeys, anchorId); rotation++) {
    keys.push(deriveRotation(rotation + 1))
  }
  // The last rotation derived is the first that is not on the identity: it can match nothing, and only
  // rotation 0 is ever registered.
  if (keys.length > 1) keys.pop()?.privateKey.fill(0)
  if (deriveLegacy) keys.push(deriveLegacy())
  return keys
}

export interface PhraseMessagingDecision {
  state: PhraseMessagingState
  /** Index into the candidates of the key that is current, when `state` is `current`. */
  candidate: number | null
}

/**
 * `current` is the anchor's current key as `identities.contractKeys` reports
 * it (null for none); `identityKeys` the identity's keys, read fresh, whose
 * newest live anchor key stands in when that read finds none. `candidates` are
 * the public keys of {@link messagingKeyCandidates}.
 * - current: the identity's current key is one of the phrase's candidates: use it.
 * - absent: there is no current key, and no anchor-bound ENCRYPTION key is on
 *   the identity in any state, the phrase's or another wallet's: add rotation
 *   0 (the first candidate).
 * - another-wallet: a current or live key is none of the candidates, or the
 *   identity has anchor keys and all are disabled (DIP rule 2: omit). It is
 *   never replaced at sign-in: replacing it would orphan everything peers
 *   encrypted to it (a rotation, which only a wallet does, on request).
 */
export function phraseMessagingState(
  candidates: readonly Uint8Array[],
  current: Uint8Array | null,
  identityKeys: readonly EncryptionKeyCandidate[],
  anchorId: string,
): PhraseMessagingDecision {
  const indexOf = (data: Uint8Array): number => candidates.findIndex((candidate) => bytesEqual(candidate, data))
  const decide = (data: Uint8Array): PhraseMessagingDecision => {
    const candidate = indexOf(data)
    return candidate === -1 ? { state: 'another-wallet', candidate: null } : { state: 'current', candidate }
  }
  if (current) return decide(current)
  // The current-key read can lag the identity: its newest live anchor key decides then, as in #1210.
  const newest = findAnchorEncryptionKey([...identityKeys], anchorId)
  if (newest) {
    const data = normalizeBytes(newest.data)
    return data === null ? { state: 'another-wallet', candidate: null } : decide(data)
  }
  // Any anchor key on the identity, a candidate's or another wallet's, all disabled: never added beside them.
  return { state: hasAnchorEncryptionKeyInAnyState(identityKeys, anchorId) ? 'another-wallet' : 'absent', candidate: null }
}
