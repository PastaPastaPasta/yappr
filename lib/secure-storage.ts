'use client'

import {
  createBrowserSecretStore,
  type BrowserStoredKeyType,
} from 'platform-auth'
import { isLikelyWif, parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { scopedKey } from '@/lib/storage-scope'
import { keyNetwork } from '@/lib/constants'
import { appConnectEncryptionKey, hasAppConnectSession } from '@/lib/app-connect/memory-keys'
import { rememberedAnchorKey } from '@/lib/app-connect/anchor-key-mark'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { purgeRetiredSecrets } from '@/lib/auth/retired-secrets'
import { sha256 } from '@noble/hashes/sha2.js'

const SECRET_PREFIX = scopedKey('yappr_secure_')

const browserSecretStore = createBrowserSecretStore({
  prefix: SECRET_PREFIX,
  // Stored secrets are WIF-encoded, so this follows the key network: devnet reuses testnet's prefixes.
  network: keyNetwork(),
  crypto: {
    parsePrivateKey,
    privateKeyToWif,
    isLikelyWif,
  },
})

export type KeyType = BrowserStoredKeyType

// A vault data key an earlier build left behind is removed on the first page load.
if (typeof window !== 'undefined') {
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      purgeRetiredSecrets(storage(), SECRET_PREFIX)
    } catch {
      // Storage missing (the mobile engine has no sessionStorage) or blocked: nothing stored to remove.
    }
  }
}

export const {
  storePrivateKey,
  storeLoginKey,
  getLoginKeyBytes,
  clearLoginKey,
  storeEncryptionKey,
  clearEncryptionKey,
  storeEncryptionKeyType,
  clearEncryptionKeyType,
  storeTransferKey,
  getTransferKey,
  hasTransferKey,
  clearTransferKey,
} = browserSecretStore

/**
 * A raw login key kept for this tab only (sessionStorage): on App Connect
 * builds a CRITICAL key typed in by hand is never persisted. Its own prefix
 * keeps the secret store from migrating it into localStorage.
 */
const SESSION_ONLY_KEY_PREFIX = scopedKey('yappr_session_pk_')

/** Where sessionStorage is blocked the key is kept in memory instead, so it still signs until the tab closes. */
const sessionOnlyMemory = new Map<string, string>()

/**
 * A moderator's CRITICAL key a passkey gave (docs/PASSKEY_VAULT.md) is kept
 * in the same session-only record, tagged: the key and its provenance are one
 * write, so neither can be stored, lost or restored without the other. Such a
 * key moderates but never signs token transitions (owner decision V2).
 * (WIF is base58, so it never contains the tag's colon.)
 */
const PASSKEY_TAG = 'passkey:'

/** The passkey CRITICAL key the commit under way is about to store, by identity (normalized WIF). */
const expectedPasskeyKeys = new Map<string, string>()

function normalizeWif(wif: string): string {
  return privateKeyToWif(parsePrivateKey(wif).privateKey, keyNetwork(), true)
}

/** Inside a sign-in commit, right before it stores `wif`: that store is a passkey's CRITICAL key, and is tagged. */
export function expectPasskeyCriticalKey(identityId: string, wif: string): void {
  expectedPasskeyKeys.set(identityId, normalizeWif(wif))
}

/** After that store (or if it never came): nothing further is expected. */
export function settlePasskeyCriticalKey(identityId: string): void {
  expectedPasskeyKeys.delete(identityId)
}

export function storeSessionOnlyPrivateKey(identityId: string, wif: string): void {
  if (typeof window === 'undefined') return
  const normalized = normalizeWif(wif)
  const fromPasskey = expectedPasskeyKeys.get(identityId) === normalized
  expectedPasskeyKeys.delete(identityId)
  const record = fromPasskey ? PASSKEY_TAG + normalized : normalized
  try {
    sessionStorage.setItem(SESSION_ONLY_KEY_PREFIX + identityId, record)
    sessionOnlyMemory.delete(identityId)
  } catch {
    sessionOnlyMemory.set(identityId, record)
  }
  // Only now that this tab holds it is the persisted copy dropped.
  browserSecretStore.clearPrivateKey(identityId)
}

function getSessionOnlyRecord(identityId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = sessionStorage.getItem(SESSION_ONLY_KEY_PREFIX + identityId)
    if (stored !== null) return stored
  } catch {
    // Storage blocked: fall back to the in-memory copy.
  }
  return sessionOnlyMemory.get(identityId) ?? null
}

function getSessionOnlyPrivateKey(identityId: string): string | null {
  const record = getSessionOnlyRecord(identityId)
  return record?.startsWith(PASSKEY_TAG) ? record.slice(PASSKEY_TAG.length) : record
}

/**
 * Whether the key {@link getPrivateKey} returns for `identityId` is a
 * moderator's CRITICAL key from a passkey (token transitions ask for the key
 * typed in instead).
 */
export function privateKeyIsFromPasskey(identityId: string): boolean {
  if (browserSecretStore.getPrivateKey(identityId) !== null) return false
  return getSessionOnlyRecord(identityId)?.startsWith(PASSKEY_TAG) ?? false
}

export function getPrivateKey(identityId: string): string | null {
  return browserSecretStore.getPrivateKey(identityId) ?? getSessionOnlyPrivateKey(identityId)
}

export function hasPrivateKey(identityId: string): boolean {
  return getPrivateKey(identityId) !== null
}

export function clearPrivateKey(identityId: string): boolean {
  const hadSessionOnly = getSessionOnlyPrivateKey(identityId) !== null
  sessionOnlyMemory.delete(identityId)
  if (hadSessionOnly) {
    try {
      sessionStorage.removeItem(SESSION_ONLY_KEY_PREFIX + identityId)
    } catch {
      // Nothing to clear where storage is blocked.
    }
  }
  return browserSecretStore.clearPrivateKey(identityId) || hadSessionOnly
}

/**
 * The public key of each identity's stored encryption key, so the anchor check
 * below costs one point multiplication per stored key. Keyed by identity and a
 * hash of the stored WIF, so no private key is kept here.
 */
const storedPublicKeys = new Map<string, { fingerprint: string; publicKeyHex: string }>()

/**
 * The public key of the encryption key stored in this browser for
 * `identityId`, whether or not it may be used (public data: for confirming it
 * against the anchor key).
 */
export function storedEncryptionPublicKey(identityId: string): Uint8Array | null {
  const hex = storedEncryptionPublicKeyHex(identityId)
  return hex ? hexToBytes(hex) : null
}

function storedEncryptionPublicKeyHex(identityId: string): string | null {
  const wif = browserSecretStore.getEncryptionKey(identityId)
  if (!wif) return null
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(wif)))
  const cached = storedPublicKeys.get(identityId)
  if (cached?.fingerprint === fingerprint) return cached.publicKeyHex
  let publicKeyHex: string
  try {
    publicKeyHex = bytesToHex(getPublicKey(parsePrivateKey(wif).privateKey))
  } catch {
    return null
  }
  storedPublicKeys.set(identityId, { fingerprint, publicKeyHex })
  return publicKeyHex
}

/**
 * Whether a key stored in this browser may stand in for `identityId`'s
 * encryption key. On App Connect builds a wallet sign-in holds no raw login
 * key, and its only valid encryption key is the current anchor key from the
 * wallet (in memory, or nothing); a key left over from an earlier sign-in
 * must not be used in its place. A raw-key sign-in's stored key counts only
 * once this browser has confirmed it is the anchor key (anchor-key-mark.ts):
 * any other key would read and send messages no peer can match.
 */
function storedEncryptionKeyAllowed(identityId: string): boolean {
  if (!isAppConnectBuild()) return true
  // Decided by how this tab signed in, not by whatever an earlier sign-in left in storage.
  if (hasAppConnectSession(identityId) || getPrivateKey(identityId) === null) return false
  const confirmed = rememberedAnchorKey(identityId)
  return confirmed !== null && storedEncryptionPublicKeyHex(identityId) === confirmed
}

/**
 * The encryption key. An App Connect session's key (unwrapped into memory
 * from the key ring) comes first; otherwise the stored one, where allowed.
 */
export function getEncryptionKey(identityId: string): string | null {
  const sessionKey = appConnectEncryptionKey(identityId)
  if (sessionKey) return sessionKey
  return storedEncryptionKeyAllowed(identityId) ? browserSecretStore.getEncryptionKey(identityId) : null
}

export function getEncryptionKeyBytes(identityId: string): Uint8Array | null {
  const sessionKey = appConnectEncryptionKey(identityId)
  if (sessionKey) return parsePrivateKey(sessionKey).privateKey
  return storedEncryptionKeyAllowed(identityId) ? browserSecretStore.getEncryptionKeyBytes(identityId) : null
}

export function hasEncryptionKey(identityId: string): boolean {
  if (appConnectEncryptionKey(identityId) !== null) return true
  return storedEncryptionKeyAllowed(identityId) && browserSecretStore.hasEncryptionKey(identityId)
}

/** The wallet granted an App Connect session's key, so it counts as derived (not typed in). */
export function getEncryptionKeyType(identityId: string): KeyType | null {
  if (appConnectEncryptionKey(identityId)) return 'derived'
  return storedEncryptionKeyAllowed(identityId) ? browserSecretStore.getEncryptionKeyType(identityId) : null
}
