'use client'

import type {
  AuthSessionSnapshot,
  AuthUser,
  AuthVaultBundle,
  AuthVaultStatus,
  AuthVaultUnlockResult,
  PasskeyAccess,
  PlatformAuthDependencies,
  PlatformAuthEvent,
} from 'platform-auth'
import {
  decodeYapprIdentityId,
  deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin,
} from 'platform-auth'
import { logger } from '@/lib/logger'
import { KEY_EXCHANGE_CONTRACT_ID, YAPPR_CONTRACT_ID } from '@/lib/constants'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import {
  clearAuthVaultDek,
  clearEncryptionKey,
  clearEncryptionKeyType,
  clearLoginKey,
  clearPrivateKey,
  clearTransferKey,
  getAuthVaultDekBytes,
  getEncryptionKey,
  getLoginKeyBytes,
  getPrivateKey,
  getTransferKey,
  hasEncryptionKey,
  hasPrivateKey,
  storeAuthVaultDek,
  storeEncryptionKey,
  storeEncryptionKeyType,
  storeLoginKey,
  storePrivateKey,
  storeTransferKey,
} from '@/lib/secure-storage'
import { identityService } from '@/lib/services/identity-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { profileService } from '@/lib/services/profile-service'
import { authVaultService } from '@/lib/services/auth-vault-service'
import { authVaultAccessService } from '@/lib/services/auth-vault-access-service'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { vaultService } from '@/lib/services/vault-service'
import {
  createPasskeyWithPrf,
  getDefaultRpId,
  getPrfAssertionForCredentials,
  selectDiscoverablePasskey,
} from '@/lib/webauthn/passkey-prf'
import { decodeBinaryFromBase64, wrapDekWithPassword, wrapDekWithPrf } from '@/lib/crypto/auth-vault'
import { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } from '@/lib/crypto/key-derivation'
import { hasEncryptionKeyOnIdentity } from '@/lib/crypto/encryption-key-lookup'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { getDashPlatformClient } from '@/lib/dash-platform-client'
import { invalidateBlockCache } from '@/lib/caches/block-cache'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { extractErrorMessage } from '@/lib/error-utils'
import { keyExchangeService } from '@/lib/services/key-exchange-service'
import {
  buildUnsignedKeyRegistrationTransition,
  checkKeysRegistered,
} from '@/lib/services/identity-update-builder'

type LegacyAuthVaultBundle = {
  version: 1
  identityId: string
  network: 'testnet' | 'mainnet'
  secretKind: 'login-key' | 'auth-key'
  loginKey?: string
  authKeyWif?: string
  encryptionKeyWif?: string
  transferKeyWif?: string
  source: 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'
  updatedAt: number
}

function getConfiguredNetwork(): 'testnet' | 'mainnet' {
  return (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
}

async function ensureSdk(): Promise<void> {
  await evoSdkService.initialize({
    network: getConfiguredNetwork(),
    contractId: YAPPR_CONTRACT_ID,
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
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

function fromLegacyBundle(bundle: LegacyAuthVaultBundle): AuthVaultBundle {
  return {
    version: bundle.version,
    identityId: bundle.identityId,
    network: bundle.network,
    secretKind: bundle.secretKind,
    loginKey: bundle.loginKey ? decodeBinaryFromBase64(bundle.loginKey) : undefined,
    authKeyWif: bundle.authKeyWif,
    encryptionKeyWif: bundle.encryptionKeyWif,
    transferKeyWif: bundle.transferKeyWif,
    source: bundle.source,
    updatedAt: bundle.updatedAt,
  }
}

function toLegacyBundle(bundle: AuthVaultBundle): LegacyAuthVaultBundle {
  return {
    version: 1,
    identityId: bundle.identityId,
    network: bundle.network,
    secretKind: bundle.secretKind,
    loginKey: bundle.loginKey ? bytesToBase64(bundle.loginKey) : undefined,
    authKeyWif: bundle.authKeyWif,
    encryptionKeyWif: bundle.encryptionKeyWif,
    transferKeyWif: bundle.transferKeyWif,
    source: bundle.source,
    updatedAt: bundle.updatedAt,
  }
}

function fromUnlockResult(result: {
  identityId: string
  vault: { $id: string }
  bundle: LegacyAuthVaultBundle
  dek: Uint8Array
}): AuthVaultUnlockResult {
  return {
    identityId: result.identityId,
    vault: { $id: result.vault.$id },
    bundle: fromLegacyBundle(result.bundle),
    dek: result.dek,
  }
}

function toPasskeyAccess(access: Awaited<ReturnType<typeof authVaultAccessService.getPasskeyAccesses>>[number]): PasskeyAccess {
  return {
    $id: access.$id,
    $ownerId: access.$ownerId,
    label: access.label,
    credentialId: access.credentialId,
    credentialIdHash: access.credentialIdHash,
    prfInput: access.prfInput,
    rpId: access.rpId,
  }
}

async function runPostLogin(identityId: string, context: { delayMs: number; isSessionActive: () => boolean }): Promise<void> {
  void import('@/lib/services/block-service').then(async ({ blockService }) => {
    try {
      await blockService.initializeBlockData(identityId)
      logger.info('Auth: Block data initialized')
    } catch (error) {
      logger.error('Auth: Failed to initialize block data:', error)
    }
  })

  void import('@/lib/services/private-feed-follower-service').then(async ({ privateFeedFollowerService }) => {
    if (!context.isSessionActive()) {
      logger.info('Auth: Skipping private feed sync - session no longer active')
      return
    }

    try {
      const result = await privateFeedFollowerService.syncFollowedFeeds()
      if (!context.isSessionActive()) {
        logger.info('Auth: Private feed sync completed but session ended - clearing keys')
        privateFeedKeyStore.clearAllKeys()
        return
      }

      if (result.synced.length > 0 || result.failed.length > 0) {
        logger.info(`Auth: Private feed sync complete - synced: ${result.synced.length}, failed: ${result.failed.length}, up-to-date: ${result.upToDate.length}`)
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
  sessionStorage.removeItem('yappr_dpns_username')
  sessionStorage.removeItem('yappr_skip_dpns')
  sessionStorage.removeItem('yappr_backup_prompt_shown')
  invalidateBlockCache(identityId)
  privateFeedKeyStore.clearAllKeys()
}

export function createYapprPlatformAuthDependencies(): PlatformAuthDependencies {
  return {
    network: getConfiguredNetwork(),
    sessionStore: {
      getSession() {
        if (typeof window === 'undefined') return null
        const savedSession = localStorage.getItem('yappr_session')
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
      },
      setSession(snapshot) {
        if (typeof window === 'undefined') return
        localStorage.setItem('yappr_session', JSON.stringify(toStoredSession(snapshot)))
      },
      clearSession() {
        if (typeof window === 'undefined') return
        localStorage.removeItem('yappr_session')
      },
    },
    secretStore: {
      storePrivateKey,
      getPrivateKey,
      hasPrivateKey,
      clearPrivateKey: async (identityId) => {
        clearPrivateKey(identityId)
      },
      storeEncryptionKey,
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
      storeAuthVaultDek,
      getAuthVaultDek: async (identityId) => getAuthVaultDekBytes(identityId),
      clearAuthVaultDek: async (identityId) => {
        clearAuthVaultDek(identityId)
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
        return dpnsService.resolveUsername(identityId)
      },
      async resolveIdentity(identityOrUsername) {
        await ensureSdk()
        return dpnsService.resolveIdentity(identityOrUsername)
      },
      clearCache(username, identityId) {
        dpnsService.clearCache(username, identityId)
      },
    },
    profiles: {
      async hasProfile(identityId, username) {
        await ensureSdk()
        const unifiedProfile = await unifiedProfileService.getProfile(identityId, username)
        if (unifiedProfile) return true
        const legacyProfile = await profileService.getProfile(identityId, username)
        return Boolean(legacyProfile)
      },
    },
    clientIdentity: {
      setIdentity(identityId) {
        getDashPlatformClient().setIdentity(identityId)
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
      deriveEncryptionKeyFromLogin: deriveYapprEncryptionKeyFromLogin,
    },
    yapprKeyExchangeConfig: {
      appContractId: YAPPR_CONTRACT_ID,
      keyExchangeContractId: KEY_EXCHANGE_CONTRACT_ID,
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
    vault: {
      isConfigured() {
        return authVaultService.isConfigured()
      },
      async getStatus(identityId): Promise<AuthVaultStatus> {
        await ensureSdk()
        return authVaultService.getStatus(identityId)
      },
      async hasVault(identityId) {
        await ensureSdk()
        return authVaultService.hasVault(identityId)
      },
      async resolveIdentityId(identityOrUsername) {
        await ensureSdk()
        return authVaultService.resolveIdentityId(identityOrUsername)
      },
      async createOrUpdateVaultBundle(identityId, bundle, dek) {
        await ensureSdk()
        const created = await authVaultService.createOrUpdateVaultBundle(identityId, toLegacyBundle(bundle), dek)
        return fromUnlockResult(created)
      },
      async mergeSecrets(identityId, dek, partialSecrets) {
        await ensureSdk()
        const merged = await authVaultService.mergeSecrets(identityId, dek, {
          loginKey: partialSecrets.loginKey,
          authKeyWif: partialSecrets.authKeyWif,
          encryptionKeyWif: partialSecrets.encryptionKeyWif,
          transferKeyWif: partialSecrets.transferKeyWif,
          source: partialSecrets.source,
        })
        return merged ? fromUnlockResult(merged) : null
      },
      async unlockWithPassword(identityOrUsername, password) {
        await ensureSdk()
        const unlocked = await authVaultService.unlockWithPassword(identityOrUsername, password)
        return fromUnlockResult(unlocked)
      },
      async unlockWithPrf(identityId, access, prfOutput) {
        await ensureSdk()
        const accesses = await authVaultAccessService.getPasskeyAccesses(identityId)
        const matchingAccess = accesses.find((entry) => entry.$id === access.$id)
        if (!matchingAccess) {
          throw new Error('Selected passkey is not registered for this site')
        }
        const unlocked = await authVaultService.unlockWithPrf(identityId, matchingAccess, prfOutput)
        return fromUnlockResult(unlocked)
      },
      async getPasskeyAccesses(identityId) {
        await ensureSdk()
        const accesses = await authVaultAccessService.getPasskeyAccesses(identityId)
        return accesses.map(toPasskeyAccess)
      },
      async addPasswordAccess(identityId, input) {
        await ensureSdk()
        const wrapped = await wrapDekWithPassword(input.dek, input.password, input.iterations, identityId, input.vaultId)
        await authVaultAccessService.upsertPasswordAccess(identityId, {
          vaultId: input.vaultId,
          label: input.label,
          wrappedDek: wrapped.wrappedDek,
          iv: wrapped.iv,
          pbkdf2Salt: wrapped.pbkdf2Salt,
          pbkdf2Iterations: input.iterations,
        })
      },
      async addPasskeyAccess(identityId, input) {
        await ensureSdk()
        const wrapped = await wrapDekWithPrf(input.dek, input.passkey.prfOutput, identityId, input.vaultId, input.passkey.rpId)
        try {
          await authVaultAccessService.createPasskeyAccess(identityId, {
            vaultId: input.vaultId,
            label: input.passkey.label,
            wrappedDek: wrapped.wrappedDek,
            iv: wrapped.iv,
            credentialId: input.passkey.credentialId,
            credentialIdHash: input.passkey.credentialIdHash,
            prfInput: input.passkey.prfInput,
            rpId: input.passkey.rpId,
          })
        } catch (error) {
          const existing = await authVaultAccessService.getPasskeyAccesses(identityId).catch(() => [])
          if (existing.some((entry) =>
            entry.credentialIdHash &&
            input.passkey.credentialIdHash.length === entry.credentialIdHash.length &&
            input.passkey.credentialIdHash.every((byte, index) => byte === entry.credentialIdHash?.[index]),
          )) {
            return
          }
          throw error
        }
      },
    },
    passkeys: {
      getDefaultRpId,
      createPasskeyWithPrf,
      getPrfAssertionForCredentials,
      selectDiscoverablePasskey,
    },
    legacyPasswordLogins: [
      {
        kind: 'vault',
        isConfigured() {
          return vaultService.isConfigured()
        },
        async loginWithPassword(identityOrUsername, password) {
          return vaultService.loginWithPassword(identityOrUsername, password)
        },
      },
      {
        kind: 'encrypted-key-backup',
        isConfigured() {
          return encryptedKeyService.isConfigured()
        },
        async loginWithPassword(identityOrUsername, password) {
          const result = await encryptedKeyService.loginWithPassword(identityOrUsername, password)
          return {
            identityId: result.identityId,
            privateKey: result.privateKey,
          }
        },
      },
    ],
    logger,
    onEvent(event: PlatformAuthEvent) {
      if (event.type === 'background-error') {
        logger.error(`platform-auth background error (${event.operation}):`, extractErrorMessage(event.error))
      }
    },
  }
}
