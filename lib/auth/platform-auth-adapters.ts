'use client'

import { scopedKey, SESSION_STORAGE_KEY } from '@/lib/storage-scope'
import type {
  AuthSessionSnapshot,
  AuthUser,
  PlatformAuthDependencies,
  PlatformAuthEvent,
} from 'platform-auth'
import { decodeYapprIdentityId, deriveYapprAuthKeyFromLogin } from 'platform-auth'
import { logger } from '@/lib/logger'
import { KEY_EXCHANGE_CONTRACT_ID, YAPPR_CONTRACT_ID, getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import {
  clearEncryptionKey,
  clearEncryptionKeyType,
  clearLoginKey,
  clearPrivateKey,
  clearTransferKey,
  getEncryptionKey,
  getLoginKeyBytes,
  getPrivateKey,
  getTransferKey,
  hasEncryptionKey,
  storeEncryptionKey,
  storeEncryptionKeyType,
  storeLoginKey,
  storePrivateKey,
  storeSessionOnlyPrivateKey,
  storeTransferKey,
} from '@/lib/secure-storage'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { identityService } from '@/lib/services/identity-service'
import { storedKeyBelongsToIdentity } from '@/lib/auth/session-key'
import { dpnsService } from '@/lib/services/dpns-service'
import { deriveEncryptionKey, deriveLoginEncryptionKey } from '@/lib/crypto/derive-encryption-key'
import { validateDerivedKeyMatchesIdentity } from '@/lib/crypto/key-derivation'
import { hasEncryptionKeyOnIdentity } from '@/lib/crypto/encryption-key-lookup'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { invalidateBlockCache } from '@/lib/caches/block-cache'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { extractErrorMessage } from '@/lib/error-utils'
import { keyExchangeService } from '@/lib/services/key-exchange-service'
import {
  buildUnsignedKeyRegistrationTransition,
  checkKeysRegistered,
} from '@/lib/services/identity-update-builder'

async function ensureSdk(): Promise<void> {
  await evoSdkService.initialize({
    network: getConfiguredNetwork(),
    contractId: YAPPR_CONTRACT_ID,
  })
}

function fromSessionUser(savedUser: Record<string, unknown>): AuthUser | null {
  const identityId = typeof savedUser.identityId === 'string' ? savedUser.identityId : null
  if (!identityId) return null

  return {
    identityId,
    balance: typeof savedUser.balance === 'number' ? savedUser.balance : 0,
    username: typeof savedUser.dpnsUsername === 'string'
      ? savedUser.dpnsUsername
      : typeof savedUser.username === 'string'
        ? savedUser.username
        : undefined,
    publicKeys: Array.isArray(savedUser.publicKeys) ? savedUser.publicKeys as AuthUser['publicKeys'] : [],
  }
}

function readStoredSession(): AuthSessionSnapshot | null {
  if (typeof window === 'undefined') return null
  const savedSession = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!savedSession) return null

  try {
    const parsed = JSON.parse(savedSession) as { user?: Record<string, unknown>; timestamp?: number }
    if (!parsed.user) return null
    const user = fromSessionUser(parsed.user)
    if (!user) return null
    return toSessionSnapshot(user, typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now())
  } catch (error) {
    logger.error('Failed to parse session:', error)
    return null
  }
}

/**
 * platform-auth calls `secretStore.hasPrivateKey` only to decide whether the
 * saved session can be restored. A stored key that belongs to another
 * identity must not restore it either, so the key must also sign for the
 * session identity; otherwise the controller clears the session.
 */
async function hasSessionPrivateKey(identityId: string): Promise<boolean> {
  // An App Connect key ring restores from IndexedDB alone, without the network.
  if (isAppConnectBuild() && await appConnectSessions.restore(identityId)) return true
  const wif = getPrivateKey(identityId)
  if (!wif) return false
  const session = readStoredSession()
  // `data` is optional on the session shape and required by the matcher.
  const sessionKeys = session?.user.identityId === identityId
    ? session.user.publicKeys.map((key) => ({ ...key, data: key.data }))
    : []
  const belongs = await storedKeyBelongsToIdentity(wif, sessionKeys, async () => {
    await ensureSdk()
    return (await identityService.getIdentity(identityId))?.publicKeys ?? null
  }, keyNetwork())
  if (!belongs) logger.warn(`Session restore: the stored key does not belong to ${identityId}; signing out`)
  return belongs
}

/**
 * On App Connect builds a raw key typed in by hand is a one-key session, and a
 * CRITICAL one (or one whose level cannot be told) is kept for this tab only.
 * The session user, with the identity's keys, is saved just before this runs.
 * The raw key replaces this tab's wallet grant for the identity, so writes
 * sign with the key the user just entered.
 */
async function storeRawLoginKey(identityId: string, wif: string): Promise<void> {
  if (!isAppConnectBuild()) {
    storePrivateKey(identityId, wif)
    return
  }
  await appConnectSessions.yieldToRawKey(identityId)
  const session = readStoredSession()
  const keys = session?.user.identityId === identityId
    ? session.user.publicKeys.map((key) => ({ ...key, data: key.data }))
    : []
  const match = matchIdentityKey(wif, keys, {
    network: keyNetwork(),
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: [SecurityLevel.HIGH],
  })
  if (match.ok) storePrivateKey(identityId, wif)
  else storeSessionOnlyPrivateKey(identityId, wif)
}

function toSessionSnapshot(user: AuthUser, timestamp: number): AuthSessionSnapshot {
  return {
    user,
    timestamp,
  }
}

function toStoredSession(snapshot: AuthSessionSnapshot): Record<string, unknown> {
  return {
    user: {
      identityId: snapshot.user.identityId,
      balance: snapshot.user.balance,
      dpnsUsername: snapshot.user.username,
      publicKeys: snapshot.user.publicKeys,
    },
    timestamp: snapshot.timestamp,
  }
}

async function runPostLogin(identityId: string, context: { delayMs: number; isSessionActive: () => boolean }): Promise<void> {
  void import('@/lib/services/block-service').then(async ({ blockService }) => {
    try {
      await blockService.initializeBlockData(identityId)
      logger.debug('Auth: Block data initialized')
    } catch (error) {
      logger.error('Auth: Failed to initialize block data:', error)
    }
  })

  void import('@/lib/services/private-feed-follower-service').then(async ({ privateFeedFollowerService }) => {
    if (!context.isSessionActive()) {
      logger.debug('Auth: Skipping private feed sync - session no longer active')
      return
    }

    try {
      const result = await privateFeedFollowerService.syncFollowedFeeds()
      if (!context.isSessionActive()) {
        logger.debug('Auth: Private feed sync completed but session ended - clearing keys')
        privateFeedKeyStore.clearAllKeys()
        return
      }

      if (result.synced.length > 0 || result.failed.length > 0) {
        logger.debug(`Auth: Private feed sync complete - synced: ${result.synced.length}, failed: ${result.failed.length}, up-to-date: ${result.upToDate.length}`)
      }
    } catch (error) {
      logger.error('Auth: Failed to sync private feed keys:', error)
    }
  })

  window.setTimeout(async () => {
    try {
      const { dashPayContactsService } = await import('@/lib/services/dashpay-contacts-service')
      const result = await dashPayContactsService.getUnfollowedContacts(identityId)

      if (result.contacts.length > 0) {
        const { useDashPayContactsModal } = await import('@/hooks/use-dashpay-contacts-modal')
        useDashPayContactsModal.getState().open()
      }
    } catch (error) {
      logger.error('Auth: Failed to check Dash Pay contacts:', error)
    }
  }, context.delayMs)
}

async function runLogoutCleanup(identityId: string): Promise<void> {
  sessionStorage.removeItem(scopedKey('yappr_dpns_username'))
  sessionStorage.removeItem(scopedKey('yappr_skip_dpns'))
  invalidateBlockCache(identityId)
  privateFeedKeyStore.clearAllKeys()
}

export function createYapprPlatformAuthDependencies(): PlatformAuthDependencies {
  return {
    // platform-auth uses this only for address/WIF encoding, so devnet maps to testnet.
    network: keyNetwork(),
    // A profile is optional: the DPNS name stands in until the user edits one.
    features: { profileGate: false },
    sessionStore: {
      getSession: readStoredSession,
      setSession(snapshot) {
        if (typeof window === 'undefined') return
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(toStoredSession(snapshot)))
      },
      clearSession() {
        if (typeof window === 'undefined') return
        localStorage.removeItem(SESSION_STORAGE_KEY)
      },
    },
    secretStore: {
      storePrivateKey: storeRawLoginKey,
      getPrivateKey,
      hasPrivateKey: hasSessionPrivateKey,
      clearPrivateKey: async (identityId) => {
        clearPrivateKey(identityId)
        if (!isAppConnectBuild()) return
        // Logout wipes the key ring too; the connection id stays for the next login.
        // Only while this tab holds the session: after a revoke this tab has
        // already dropped its own grant, and must not take a newer one another
        // tab stored for the same identity with it. Either way a renewal still
        // being stored is cancelled, so it cannot bring the session back.
        if (appConnectSessions.current(identityId)) await appConnectSessions.logout(identityId)
        else appConnectSessions.cancelAdoptions(identityId)
      },
      storeEncryptionKey: (identityId, encryptionKey) => {
        storeEncryptionKey(identityId, encryptionKey)
        // App Connect builds: a stored key counts once it matches the anchor key.
        if (!isAppConnectBuild()) return
        import('@/lib/services/messaging-key-service')
          .then(({ confirmStoredEncryptionKey }) => confirmStoredEncryptionKey(identityId))
          .catch((error) => logger.warn('Could not check the stored messaging key:', error))
      },
      getEncryptionKey,
      hasEncryptionKey,
      clearEncryptionKey: async (identityId) => {
        clearEncryptionKey(identityId)
      },
      storeEncryptionKeyType,
      clearEncryptionKeyType: async (identityId) => {
        clearEncryptionKeyType(identityId)
      },
      storeTransferKey,
      getTransferKey,
      clearTransferKey: async (identityId) => {
        clearTransferKey(identityId)
      },
      storeLoginKey,
      getLoginKey: async (identityId) => getLoginKeyBytes(identityId),
      clearLoginKey: async (identityId) => {
        clearLoginKey(identityId)
      },
    },
    identity: {
      async getIdentity(identityId) {
        await ensureSdk()
        return identityService.getIdentity(identityId)
      },
      async getBalance(identityId) {
        await ensureSdk()
        const balance = await identityService.getBalance(identityId)
        return balance.confirmed
      },
      clearCache(identityId) {
        identityService.clearCache(identityId)
      },
    },
    usernames: {
      async resolveUsername(identityId) {
        await ensureSdk()
        const username = await dpnsService.resolveUsername(identityId)
        // dpnsService answers null for failed reads too; only a complete read caches the miss.
        // A name seeded by a concurrent lookup is not proof of absence either.
        if (username === null && !dpnsService.hasCachedAbsence(identityId)) {
          throw new Error('DPNS username lookup failed')
        }
        return username
      },
      async resolveIdentity(identityOrUsername) {
        await ensureSdk()
        return dpnsService.resolveIdentity(identityOrUsername)
      },
      clearCache(username, identityId) {
        dpnsService.clearCache(username, identityId)
      },
    },
    sideEffects: {
      runPostLogin,
      runLogoutCleanup,
    },
    crypto: {
      parsePrivateKey,
      privateKeyToWif,
      deriveEncryptionKey,
      validateDerivedKeyMatchesIdentity,
      identityHasEncryptionKey: hasEncryptionKeyOnIdentity,
      decodeIdentityId: decodeYapprIdentityId,
      deriveAuthKeyFromLogin: deriveYapprAuthKeyFromLogin,
      // App Connect builds: the anchor key.
      deriveEncryptionKeyFromLogin: (loginKey, identityIdBytes) => deriveLoginEncryptionKey(loginKey, identityIdBytes),
    },
    yapprKeyExchangeConfig: {
      appContractId: YAPPR_CONTRACT_ID,
      keyExchangeContractId: KEY_EXCHANGE_CONTRACT_ID,
      // Protocol routing in the dash-key:/dash-st: URIs, which distinguish
      // devnet ('d') — unlike address/WIF encoding, which keyNetwork() maps
      // to testnet on devnets.
      network: getConfiguredNetwork(),
      label: 'Login to Yappr',
    },
    yapprKeyExchange: {
      async getResponse(contractIdBytes, appEphemeralPubKeyHash) {
        await ensureSdk()
        return keyExchangeService.getResponse(contractIdBytes, appEphemeralPubKeyHash)
      },
      async buildUnsignedKeyRegistrationTransition(request) {
        await ensureSdk()
        return buildUnsignedKeyRegistrationTransition(request)
      },
      async checkKeysRegistered(identityId, authPublicKey, encryptionPublicKey) {
        await ensureSdk()
        return checkKeysRegistered(identityId, authPublicKey, encryptionPublicKey)
      },
    },
    logger,
    onEvent(event: PlatformAuthEvent) {
      if (event.type === 'background-error') {
        logger.error(`platform-auth background error (${event.operation}):`, extractErrorMessage(event.error))
      }
    },
  }
}
