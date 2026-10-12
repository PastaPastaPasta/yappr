'use client'

import {
  createBrowserSecretStore,
  type BrowserStoredKeyType,
} from 'platform-auth'
import { isLikelyWif, parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { scopedKey } from '@/lib/storage-scope'
import { keyNetwork } from '@/lib/constants'
import { appConnectEncryptionKey } from '@/lib/app-connect/memory-keys'
import { isAppConnectBuild } from '@/lib/app-connect/config'

const browserSecretStore = createBrowserSecretStore({
  prefix: scopedKey('yappr_secure_'),
  // Stored secrets are WIF-encoded, so this follows the key network: devnet reuses testnet's prefixes.
  network: keyNetwork(),
  crypto: {
    parsePrivateKey,
    privateKeyToWif,
    isLikelyWif,
  },
})

export type KeyType = BrowserStoredKeyType

export const {
  storePrivateKey,
  storeLoginKey,
  getLoginKeyBytes,
  clearLoginKey,
  storeAuthVaultDek,
  getAuthVaultDekBytes,
  clearAuthVaultDek,
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

export function storeSessionOnlyPrivateKey(identityId: string, wif: string): void {
  if (typeof window === 'undefined') return
  const normalized = privateKeyToWif(parsePrivateKey(wif).privateKey, keyNetwork(), true)
  try {
    sessionStorage.setItem(SESSION_ONLY_KEY_PREFIX + identityId, normalized)
  } catch {
    // Storage blocked: the key simply does not survive a reload.
  }
  browserSecretStore.clearPrivateKey(identityId)
}

function getSessionOnlyPrivateKey(identityId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem(SESSION_ONLY_KEY_PREFIX + identityId)
  } catch {
    return null
  }
}

export function getPrivateKey(identityId: string): string | null {
  return browserSecretStore.getPrivateKey(identityId) ?? getSessionOnlyPrivateKey(identityId)
}

export function hasPrivateKey(identityId: string): boolean {
  return getPrivateKey(identityId) !== null
}

export function clearPrivateKey(identityId: string): boolean {
  const hadSessionOnly = getSessionOnlyPrivateKey(identityId) !== null
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
 * Whether a key stored in this browser may stand in for `identityId`'s
 * encryption key. On App Connect builds a wallet sign-in holds no raw login
 * key, and its only valid encryption key is the current anchor key from the
 * wallet (in memory, or nothing); a key left over from an earlier sign-in
 * must not be used in its place.
 */
function storedEncryptionKeyAllowed(identityId: string): boolean {
  return !isAppConnectBuild() || getPrivateKey(identityId) !== null
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
