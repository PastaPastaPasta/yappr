/**
 * The passkey vault's rules, free of the SDK and the browser
 * (docs/PASSKEY_VAULT.md): where passkeys are offered, which keys may be
 * stored for whom, and when an entry needs updating. lib/auth/passkey-vault.ts
 * applies them to the chain and the session.
 */
import { APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS, KeyPurpose, KeySecurityLevel, KeyType, type AppConnectGrant, type AppConnectIdentityKey } from 'platform-auth'
import { bytesEqual } from '@/lib/bytes'
import { hash160 } from '@/lib/crypto/hash'
import { getPublicKey } from '@/lib/crypto/keys'
import { BundleFormat, type VaultBundle, type VaultKey } from '@/lib/crypto/passkey-vault'

/** Passkeys one identity may have (the client's cap; the contract has none). */
export const MAX_PASSKEYS = 10

/** Yappr's relying party: passkeys work on yap.pr (its /staging and /testing paths too), never on mirrors. */
const PRODUCTION_RP_ID = 'yap.pr'

/**
 * The relying party id for a page on `hostname`, or null where passkeys are
 * not offered. Mirrors and archives (yappr.pages.dev, the versioned mirrors)
 * offer wallet and key sign-in only: a passkey made there would be bound to
 * that host. `localhost` is for development and the end-to-end tests.
 */
export function passkeyRpId(hostname: string): string | null {
  if (hostname === PRODUCTION_RP_ID || hostname === 'localhost') return hostname
  return null
}

/** The name the passkey picker shows: the username, marked off the networks people use day to day. */
export function passkeyDisplayName(name: string, context: { network: string; scope: string }): string {
  if (context.network === 'devnet') return `${name} (devnet)`
  if (context.scope === 'testing') return `${name} (testing)`
  return name
}

/** Whether `privateKey` is the private half of the identity key `key` (a full point or its hash160). */
export function privateKeyMatches(privateKey: Uint8Array, key: Pick<AppConnectIdentityKey, 'type' | 'data'>): boolean {
  let publicKey: Uint8Array
  try {
    publicKey = getPublicKey(privateKey)
  } catch {
    return false
  }
  if (key.type === KeyType.ECDSA_SECP256K1) return bytesEqual(key.data, publicKey)
  if (key.type === KeyType.ECDSA_HASH160) return bytesEqual(key.data, hash160(publicKey))
  return false
}

/** A key that can sign right now: enabled, and not expiring within the signing margin. */
function live(key: AppConnectIdentityKey, now: number): boolean {
  return key.disabledAt === undefined && (key.expiresAt === undefined || key.expiresAt - now > APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS)
}

/**
 * Whether an entry sealed for sign-in key `authKeyId` needs updating: that
 * key is gone, disabled or (a wallet key) expired. An entry whose key still
 * works stays as it is, even when this session signs with another key, so
 * nobody is asked to update passkeys that still sign in.
 */
export function entryNeedsUpdate(authKeyId: number, keys: readonly AppConnectIdentityKey[], now: number): boolean {
  const key = keys.find((candidate) => candidate.id === authKeyId)
  return !key || key.purpose !== KeyPurpose.AUTHENTICATION || !live(key, now)
}

export type SignInKeyCheck =
  | { ok: true; key: AppConnectIdentityKey; needsModerator: boolean }
  | { ok: false }

/**
 * The WebAuthn user handle: the identity id, then the vault contract id (64
 * bytes, the most WebAuthn allows). Every deployment on yap.pr shares the
 * relying party, so the contract id keeps a passkey made on /testing from
 * replacing the same identity's production passkey in the provider (they
 * replace a passkey with the same relying party and user handle). /staging
 * shares production's contracts, so it shares its passkeys too.
 */
export function passkeyUserHandle(identityId: Uint8Array, contractId: Uint8Array): Uint8Array {
  if (identityId.length !== 32 || contractId.length !== 32) throw new Error('the identity and contract ids must be 32 bytes')
  const handle = new Uint8Array(64)
  handle.set(identityId)
  handle.set(contractId, 32)
  return handle
}

/** The identity a user handle names for this vault contract, or null when it is not one of this deployment's. */
export function identityOfUserHandle(handle: Uint8Array | null, contractId: Uint8Array): Uint8Array | null {
  if (!handle || handle.length !== 64 || !bytesEqual(handle.subarray(32), contractId)) return null
  return handle.slice(0, 32)
}

/**
 * A raw sign-in key, at enrolment or after opening a bundle, against the
 * identity read fresh: an enabled AUTHENTICATION key at the slot's level,
 * HIGH or CRITICAL, whose public key the private key matches. A CRITICAL key
 * may be kept only for a moderator (`needsModerator`) unless it is bound to a
 * contract group, like a wallet's group key, which signs only for the group.
 */
export function checkSignInKey(slot: VaultKey, keys: readonly AppConnectIdentityKey[], now: number): SignInKeyCheck {
  const key = keys.find((candidate) => candidate.id === slot.keyId)
  if (!key || !live(key, now)) return { ok: false }
  if (key.purpose !== KeyPurpose.AUTHENTICATION || key.securityLevel !== slot.securityLevel || key.type !== slot.keyType) return { ok: false }
  if (key.securityLevel !== KeySecurityLevel.CRITICAL && key.securityLevel !== KeySecurityLevel.HIGH) return { ok: false }
  if (!privateKeyMatches(slot.privateKey, key)) return { ok: false }
  return { ok: true, key, needsModerator: key.securityLevel === KeySecurityLevel.CRITICAL && key.bounds?.kind !== 'contractGroup' }
}

/** A grant's primary key: the group key answering binding 0. */
export function primaryGrantedKey(grant: AppConnectGrant): AppConnectGrant['authKeys'][number] | undefined {
  return grant.authKeys.find((granted) => granted.role === 'contractGroup' && granted.bindingIndex === 0)
}

/** The bundle slot for an identity key and its private key. */
export function slotFor(key: Pick<AppConnectIdentityKey, 'id' | 'purpose' | 'securityLevel' | 'type'>, privateKey: Uint8Array): VaultKey {
  return { purpose: key.purpose, securityLevel: key.securityLevel, keyType: key.type, keyId: key.id, privateKey }
}

/**
 * A raw-key bundle: the sign-in key, then the messaging key when the session
 * holds one that is the identity's current one.
 */
export function rawKeyBundle(signIn: VaultKey, messaging: VaultKey | null): VaultBundle {
  return { format: BundleFormat.RAW_KEY, keys: messaging ? [signIn, messaging] : [signIn] }
}

/**
 * A key-ring bundle from a verified App Connect grant: the primary group key
 * first (the entry's `authKeyId`), then the other wallet keys. Takes copies
 * of the private keys; the caller still wipes the grant.
 */
export function keyRingBundle(grant: AppConnectGrant): VaultBundle {
  const primary = primaryGrantedKey(grant)
  if (!primary) throw new Error('the wallet grant has no group key')
  const ordered = [primary, ...grant.authKeys.filter((granted) => granted !== primary), ...grant.encryptionKeys]
  return { format: BundleFormat.KEY_RING, keys: ordered.map((granted) => slotFor(granted.key, granted.privateKey.slice())) }
}
