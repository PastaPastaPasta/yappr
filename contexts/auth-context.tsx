'use client'

import { logger } from '@/lib/logger';
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useRouter } from 'next/navigation'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import type { AuthVaultBundle } from '@/lib/crypto/auth-vault'
import { extractErrorMessage, isAlreadyExistsError } from '@/lib/error-utils'

export interface AuthUser {
  identityId: string
  balance: number
  dpnsUsername?: string
  publicKeys: Array<{
    id: number
    type: number
    purpose: number
    securityLevel: number
    security_level?: number
    disabledAt?: number
    data?: string | Uint8Array
  }>
}

interface AuthContextType {
  user: AuthUser | null
  isLoading: boolean
  isAuthRestoring: boolean
  error: string | null
  login: (identityId: string, privateKey: string, options?: { skipUsernameCheck?: boolean }) => Promise<void>
  loginWithPassword: (username: string, password: string) => Promise<void>
  loginWithPasskey: (identityOrUsername?: string) => Promise<void>
  loginWithKeyExchange: (identityId: string, loginKey: Uint8Array, keyIndex: number) => Promise<void>
  createOrUpdateUnifiedVaultFromLoginKey: (identityId: string, loginKey: Uint8Array) => Promise<void>
  createOrUpdateUnifiedVaultFromAuthKey: (identityId: string, authKeyWif: string) => Promise<void>
  addPasskeyWrapper: (label?: string) => Promise<void>
  addPasswordWrapper: (password: string, iterations: number) => Promise<void>
  mergeSecretsIntoAuthVault: (identityId: string, partialSecrets: {
    loginKey?: Uint8Array | string
    authKeyWif?: string
    encryptionKeyWif?: string
    transferKeyWif?: string
    source?: 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'
  }) => Promise<void>
  logout: () => Promise<void>
  updateDPNSUsername: (username: string) => void
  refreshDpnsUsernames: () => Promise<void>
  refreshBalance: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Helper to update a field in the saved session
function updateSavedSession(updater: (sessionData: Record<string, unknown>) => void): void {
  const savedSession = localStorage.getItem('yappr_session')
  if (!savedSession) return

  try {
    const sessionData = JSON.parse(savedSession)
    updater(sessionData)
    localStorage.setItem('yappr_session', JSON.stringify(sessionData))
  } catch (e) {
    logger.error('Failed to update session:', e)
  }
}

// Helper to set DashPlatformClient identity
async function setDashPlatformClientIdentity(identityId: string): Promise<void> {
  try {
    const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
    const dashClient = getDashPlatformClient()
    dashClient.setIdentity(identityId)
  } catch (err) {
    logger.error('Failed to set DashPlatformClient identity:', err)
  }
}

// Helper to initialize post-login background tasks (block data + DashPay contacts + private feed sync)
function initializePostLoginTasks(identityId: string, delayMs: number): void {
  // Initialize block data immediately (background)
  import('@/lib/services/block-service').then(async ({ blockService }) => {
    try {
      await blockService.initializeBlockData(identityId)
      logger.info('Auth: Block data initialized')
    } catch (err) {
      logger.error('Auth: Failed to initialize block data:', err)
    }
  })

  // Sync private feed keys immediately (background) - PRD §5.4
  // Guard against logout race: check session is still active before/after sync
  import('@/lib/services/private-feed-follower-service').then(async ({ privateFeedFollowerService }) => {
    const isSessionActive = () => {
      const savedSession = localStorage.getItem('yappr_session')
      if (!savedSession) return false
      try {
        const sessionData = JSON.parse(savedSession)
        return sessionData.user?.identityId === identityId
      } catch {
        return false
      }
    }

    // Check session before starting
    if (!isSessionActive()) {
      logger.info('Auth: Skipping private feed sync - session no longer active')
      return
    }

    try {
      const result = await privateFeedFollowerService.syncFollowedFeeds()

      // Check session after sync completes (results already stored by service)
      if (!isSessionActive()) {
        logger.info('Auth: Private feed sync completed but session ended - clearing keys')
        const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
        privateFeedKeyStore.clearAllKeys()
        return
      }

      if (result.synced.length > 0 || result.failed.length > 0) {
        logger.info(`Auth: Private feed sync complete - synced: ${result.synced.length}, failed: ${result.failed.length}, up-to-date: ${result.upToDate.length}`)
      }
    } catch (err) {
      logger.error('Auth: Failed to sync private feed keys:', err)
    }
  })

  // Check for DashPay contacts after delay
  setTimeout(async () => {
    try {
      const { dashPayContactsService } = await import('@/lib/services/dashpay-contacts-service')
      const result = await dashPayContactsService.getUnfollowedContacts(identityId)

      if (result.contacts.length > 0) {
        const { useDashPayContactsModal } = await import('@/hooks/use-dashpay-contacts-modal')
        useDashPayContactsModal.getState().open()
      }
    } catch (err) {
      logger.error('Auth: Failed to check Dash Pay contacts:', err)
    }
  }, delayMs)
}

// Loading spinner shown during auth state transitions
function AuthLoadingSpinner(): JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <Spinner size="md" />
    </div>
  )
}

/**
 * Attempt to derive encryption key and check if it matches the identity.
 * If it matches, stores the key and marks it as 'derived'.
 * Returns the derived key bytes if successful, null otherwise.
 *
 * @param identityId - The identity to derive key for
 * @param authPrivateKey - The authentication private key bytes
 * @param isSessionActive - Callback to check if session is still active for this identity
 */
async function attemptEncryptionKeyDerivation(
  identityId: string,
  authPrivateKey: Uint8Array,
  isSessionActive: () => boolean
): Promise<Uint8Array | null> {
  try {
    const { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } =
      await import('@/lib/crypto/key-derivation')
    const { storeEncryptionKey, storeEncryptionKeyType, getAuthVaultDekBytes } = await import('@/lib/secure-storage')
    const { privateKeyToWif } = await import('@/lib/crypto/wif')

    // Derive the encryption key
    const derivedKey = deriveEncryptionKey(authPrivateKey, identityId)

    // Check if it matches the identity's key
    const matches = await validateDerivedKeyMatchesIdentity(derivedKey, identityId)

    if (matches) {
      // Check if session is still active before storing keys
      // This prevents resurrecting keys after logout
      if (!isSessionActive()) {
        logger.info('Auth: Session ended before key derivation completed, skipping storage')
        return null
      }

      // Convert to WIF and store
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
      const wif = privateKeyToWif(derivedKey, network, true)
      storeEncryptionKey(identityId, wif)
      storeEncryptionKeyType(identityId, 'derived')

      const dek = getAuthVaultDekBytes(identityId)
      if (dek) {
        const { authVaultService } = await import('@/lib/services/auth-vault-service')
        await authVaultService.mergeSecrets(identityId, dek, {
          encryptionKeyWif: wif,
        }).catch((mergeError) => {
          logger.warn('Auth: Failed to merge derived encryption key into auth vault:', mergeError)
        })
      }

      logger.info('Auth: Encryption key derived and stored')
      return derivedKey
    }

    return null
  } catch (error) {
    logger.error('Auth: Failed to derive encryption key:', error)
    return null
  }
}

function getConfiguredNetwork(): 'testnet' | 'mainnet' {
  return (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
}

function sameBytes(left?: Uint8Array, right?: Uint8Array): boolean {
  if (!left || !right || left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function toFriendlyVaultWriteError(error: unknown, methodLabel: 'passkey' | 'password'): Error {
  const message = extractErrorMessage(error)
  const normalized = message.toLowerCase()

  if (isAlreadyExistsError(error)) {
    if (methodLabel === 'passkey') {
      return new Error('This passkey is already registered for this account on this site.')
    }
    return new Error('A password unlock method is already configured for this account.')
  }

  if (normalized.includes('unknown contract')) {
    return new Error('The auth vault contract is still propagating across Dash Platform. Please try again in a moment.')
  }

  if (
    normalized.includes('grpc error') ||
    normalized.includes('transport error') ||
    normalized.includes('missing response message')
  ) {
    return new Error(`Dash Platform could not save your ${methodLabel} unlock method right now. Please try again in a moment.`)
  }

  return error instanceof Error ? error : new Error(message)
}


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isAuthRestoring, setIsAuthRestoring] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  // Check for saved session on mount
  useEffect(() => {
    async function restoreSession(): Promise<void> {
      const savedSession = localStorage.getItem('yappr_session')
      if (!savedSession) return

      try {
        const sessionData = JSON.parse(savedSession)
        const savedUser = sessionData.user

        // Validate private key exists before restoring session
        const { hasPrivateKey } = await import('@/lib/secure-storage')
        if (!hasPrivateKey(savedUser.identityId)) {
          logger.warn('Auth: Session found but private key missing - clearing invalid session')
          localStorage.removeItem('yappr_session')
          return
        }

        // Set user only after validating key exists
        setUser(savedUser)

        // Set identity in DashPlatformClient for document operations
        await setDashPlatformClientIdentity(savedUser.identityId)
        logger.info('Auth: DashPlatformClient identity restored from session')

        // If user doesn't have DPNS username, fetch it in background
        if (savedUser && !savedUser.dpnsUsername) {
          logger.info('Auth: Fetching DPNS username in background...')
          import('@/lib/services/dpns-service').then(async ({ dpnsService }) => {
            try {
              const dpnsUsername = await dpnsService.resolveUsername(savedUser.identityId)
              if (dpnsUsername) {
                logger.info('Auth: Found DPNS username:', dpnsUsername)
                setUser(prev => prev ? { ...prev, dpnsUsername } : prev)
                updateSavedSession(data => { (data.user as Record<string, unknown>).dpnsUsername = dpnsUsername })
              }
            } catch (e) {
              logger.error('Auth: Background DPNS fetch failed:', e)
            }
          })
        }

        // Initialize background tasks (block data + DashPay contacts)
        initializePostLoginTasks(savedUser.identityId, 3000)
      } catch (e) {
        logger.error('Failed to restore session:', e)
        localStorage.removeItem('yappr_session')
      }
    }

    restoreSession().finally(() => {
      setIsAuthRestoring(false)
    })
  }, [])

  const login = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean } = {}) => {
    const { skipUsernameCheck = false } = options
    setIsLoading(true)
    setError(null)

    try {
      // Validate inputs
      if (!identityId || !privateKey) {
        throw new Error('Identity ID and private key are required')
      }

      // Use the EvoSDK services
      const { identityService } = await import('@/lib/services/identity-service')
      const { evoSdkService } = await import('@/lib/services/evo-sdk-service')

      // Initialize SDK if needed
      await evoSdkService.initialize({
        network: (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet',
        contractId: YAPPR_CONTRACT_ID
      })

      logger.info('Fetching identity with EvoSDK...')
      const identityData = await identityService.getIdentity(identityId)

      if (!identityData) {
        throw new Error('Identity not found')
      }

      // Check for DPNS username
      const { dpnsService } = await import('@/lib/services/dpns-service')
      const dpnsUsername = await dpnsService.resolveUsername(identityData.id)

      const authUser: AuthUser = {
        identityId: identityData.id,
        balance: identityData.balance,
        dpnsUsername: dpnsUsername || undefined,
        publicKeys: identityData.publicKeys
      }

      // Save session (note: private key is not saved, only used for login)
      // Convert any BigInt values to numbers for JSON serialization
      const sessionData = {
        user: {
          ...authUser,
          balance: typeof authUser.balance === 'bigint' ? Number(authUser.balance) : authUser.balance
        },
        timestamp: Date.now()
      }
      localStorage.setItem('yappr_session', JSON.stringify(sessionData))

      const { storePrivateKey, hasEncryptionKey } = await import('@/lib/secure-storage')
      storePrivateKey(identityId, privateKey)

      setUser(authUser)

      // Set identity in DashPlatformClient for document operations
      await setDashPlatformClientIdentity(identityId)

      // Attempt key derivation for encryption key (background, non-blocking)
      // This auto-derives and stores the encryption key if it matches identity
      // Use fire-and-forget IIFE so this doesn't block login
      // Capture identityId to check session is still active when derivation completes
      const loginIdentityId = identityId
      ;(async () => {
        try {
          const { parsePrivateKey } = await import('@/lib/crypto/wif')
          const { privateKey: authPrivateKeyBytes } = parsePrivateKey(privateKey)

          // Check if identity has encryption key (purpose=1)
          const { hasEncryptionKeyOnIdentity: checkEncKey } = await import('@/lib/crypto/encryption-key-lookup')
          const hasEncryptionKeyOnIdentity = checkEncKey(authUser.publicKeys)

          if (hasEncryptionKeyOnIdentity && !hasEncryptionKey(identityId)) {
            // Try to derive encryption key
            // Pass session check callback to prevent storing keys after logout
            logger.info('Auth: Attempting encryption key derivation...')
            const isSessionActive = () => {
              const savedSession = localStorage.getItem('yappr_session')
              if (!savedSession) return false
              try {
                const sessionData = JSON.parse(savedSession)
                return sessionData.user?.identityId === loginIdentityId
              } catch {
                return false
              }
            }
            const derivedEncKey = await attemptEncryptionKeyDerivation(identityId, authPrivateKeyBytes, isSessionActive)

            if (!derivedEncKey) {
              // Derivation didn't match - user has external key, will need to enter it manually
              logger.info('Auth: Encryption key derivation failed - external key exists on identity')
              // Note: The encryption-key-modal will handle prompting for manual entry
            }
          }
        } catch (err) {
          logger.warn('Encryption key derivation failed (non-fatal):', err)
        }
      })()

      // First check if user has DPNS username (unless skipped)
      logger.info('Checking for DPNS username...')
      if (!authUser.dpnsUsername && !skipUsernameCheck) {
        logger.info('No DPNS username found, opening username modal...')
        // Import and use the username modal store
        const { useUsernameModal } = await import('@/hooks/use-username-modal')
        useUsernameModal.getState().open(identityId)
        return
      }
      
      // Then check if user has a profile (check new unified profile first, then old)
      logger.info('Checking for user profile...')
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const { profileService } = await import('@/lib/services/profile-service')
      let profile = await unifiedProfileService.getProfile(identityId, authUser.dpnsUsername)
      if (!profile) {
        // Fall back to old profile service
        profile = await profileService.getProfile(identityId, authUser.dpnsUsername)
      }
      
      if (profile) {
        logger.info('Profile found, redirecting to feed...')
        router.push('/feed')

        // Initialize background tasks (block data + DashPay contacts)
        initializePostLoginTasks(authUser.identityId, 2000)
      } else {
        logger.info('No profile found, redirecting to profile creation...')
        router.push('/profile/create')
      }
    } catch (err) {
      logger.error('Login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [router])

  const ensureVaultForCurrentSession = useCallback(async (
    identityId: string,
    overrides: {
      loginKey?: Uint8Array
      authKeyWif?: string
      encryptionKeyWif?: string
      transferKeyWif?: string
      source?: 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'
    } = {}
  ) => {
    const { authVaultService, createAuthVaultBundle } = await import('@/lib/services/auth-vault-service')
    const {
      getPrivateKey,
      getEncryptionKey,
      getTransferKey,
      getLoginKeyBytes,
      getAuthVaultDekBytes,
      storeAuthVaultDek,
      storeLoginKey,
    } = await import('@/lib/secure-storage')

    if (!authVaultService.isConfigured()) {
      throw new Error('Auth vault is not configured')
    }

    const existingDek = getAuthVaultDekBytes(identityId)
    if (existingDek) {
      const merged = await authVaultService.mergeSecrets(identityId, existingDek, {
        loginKey: overrides.loginKey,
        authKeyWif: overrides.authKeyWif,
        encryptionKeyWif: overrides.encryptionKeyWif,
        transferKeyWif: overrides.transferKeyWif,
        source: overrides.source,
      })

      if (merged) {
        storeAuthVaultDek(identityId, merged.dek)
        const mergedLoginKey = overrides.loginKey ?? getLoginKeyBytes(identityId)
        if (mergedLoginKey) {
          storeLoginKey(identityId, mergedLoginKey)
        }
        return merged
      }
    }

    const hasExistingVault = await authVaultService.hasVault(identityId)
    if (hasExistingVault && !existingDek) {
      throw new Error('This auth vault must be unlocked on this device before it can be updated.')
    }

    const loginKey = overrides.loginKey ?? getLoginKeyBytes(identityId) ?? undefined
    const authKeyWif = overrides.authKeyWif ?? getPrivateKey(identityId) ?? undefined
    const encryptionKeyWif = overrides.encryptionKeyWif ?? getEncryptionKey(identityId) ?? undefined
    const transferKeyWif = overrides.transferKeyWif ?? getTransferKey(identityId) ?? undefined

    if (!loginKey && !authKeyWif) {
      throw new Error('No active login secret is available for auth vault enrollment.')
    }

    const bundle = createAuthVaultBundle({
      identityId,
      network: getConfiguredNetwork(),
      source: overrides.source ?? (loginKey ? 'wallet-derived' : 'direct-key'),
      loginKey,
      authKeyWif,
      encryptionKeyWif,
      transferKeyWif,
    })

    const created = await authVaultService.createOrUpdateVaultBundle(identityId, bundle, existingDek ?? undefined)
    storeAuthVaultDek(identityId, created.dek)
    if (loginKey) {
      storeLoginKey(identityId, loginKey)
    }
    return created
  }, [])

  const restoreUnlockedVaultSession = useCallback(async (
    unlocked: {
      identityId: string
      bundle: AuthVaultBundle
      dek: Uint8Array
    }
  ) => {
    const {
      storeLoginKey,
      storeAuthVaultDek,
      storeEncryptionKey,
      storeEncryptionKeyType,
      storeTransferKey,
    } = await import('@/lib/secure-storage')
    const { privateKeyToWif, parsePrivateKey } = await import('@/lib/crypto/wif')

    const identityId = unlocked.identityId
    const network = getConfiguredNetwork()
    let authKeyWif = unlocked.bundle.authKeyWif
    let encryptionKeyWif = unlocked.bundle.encryptionKeyWif
    let encryptionKeyType: 'derived' | 'external' = 'external'

    if (unlocked.bundle.secretKind === 'login-key') {
      if (!unlocked.bundle.loginKey) {
        throw new Error('Auth vault is missing the wallet login secret.')
      }

      const { getLoginKeyBytesFromBundle } = await import('@/lib/services/auth-vault-service')
      const { deriveAuthKeyFromLogin, deriveEncryptionKeyFromLogin } = await import('@/lib/crypto/key-exchange')
      const { decodeIdentityId } = await import('@/lib/crypto/key-exchange-uri')

      const loginKey = getLoginKeyBytesFromBundle(unlocked.bundle)
      if (!loginKey) {
        throw new Error('Failed to decode wallet login secret from auth vault.')
      }

      const identityIdBytes = decodeIdentityId(identityId)
      const authKey = deriveAuthKeyFromLogin(loginKey, identityIdBytes)
      const derivedEncryptionKey = deriveEncryptionKeyFromLogin(loginKey, identityIdBytes)

      authKeyWif = privateKeyToWif(authKey, network, true)
      const derivedEncryptionKeyWif = privateKeyToWif(derivedEncryptionKey, network, true)
      encryptionKeyWif = unlocked.bundle.encryptionKeyWif ?? derivedEncryptionKeyWif
      encryptionKeyType = !unlocked.bundle.encryptionKeyWif || unlocked.bundle.encryptionKeyWif === derivedEncryptionKeyWif
        ? 'derived'
        : 'external'

      storeLoginKey(identityId, loginKey)
    } else {
      if (!authKeyWif) {
        throw new Error('Auth vault is missing the authentication key.')
      }

      if (encryptionKeyWif) {
        try {
          const { deriveEncryptionKey } = await import('@/lib/crypto/key-derivation')
          const parsed = parsePrivateKey(authKeyWif)
          const derived = deriveEncryptionKey(parsed.privateKey, identityId)
          const derivedWif = privateKeyToWif(derived, network, true)
          encryptionKeyType = derivedWif === encryptionKeyWif ? 'derived' : 'external'
        } catch {
          encryptionKeyType = 'external'
        }
      }
    }

    storeAuthVaultDek(identityId, unlocked.dek)
    await login(identityId, authKeyWif, { skipUsernameCheck: true })

    if (encryptionKeyWif) {
      storeEncryptionKey(identityId, encryptionKeyWif)
      storeEncryptionKeyType(identityId, encryptionKeyType)
    }

    if (unlocked.bundle.transferKeyWif) {
      storeTransferKey(identityId, unlocked.bundle.transferKeyWif)
    }
  }, [login])

  const createOrUpdateUnifiedVaultFromLoginKey = useCallback(async (identityId: string, loginKey: Uint8Array) => {
    await ensureVaultForCurrentSession(identityId, {
      loginKey,
      source: 'wallet-derived',
    })
  }, [ensureVaultForCurrentSession])

  const createOrUpdateUnifiedVaultFromAuthKey = useCallback(async (identityId: string, authKeyWif: string) => {
    await ensureVaultForCurrentSession(identityId, {
      authKeyWif,
      source: 'direct-key',
    })
  }, [ensureVaultForCurrentSession])

  const mergeSecretsIntoAuthVault = useCallback(async (
    identityId: string,
    partialSecrets: {
      loginKey?: Uint8Array | string
      authKeyWif?: string
      encryptionKeyWif?: string
      transferKeyWif?: string
      source?: 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'
    }
  ) => {
    const { authVaultService } = await import('@/lib/services/auth-vault-service')
    const { getAuthVaultDekBytes, storeAuthVaultDek, storeLoginKey } = await import('@/lib/secure-storage')

    if (!authVaultService.isConfigured()) {
      return
    }

    const dek = getAuthVaultDekBytes(identityId)
    if (!dek) {
      return
    }

    const merged = await authVaultService.mergeSecrets(identityId, dek, partialSecrets)
    if (!merged) {
      return
    }

    storeAuthVaultDek(identityId, merged.dek)
    if (partialSecrets.loginKey && partialSecrets.loginKey instanceof Uint8Array) {
      storeLoginKey(identityId, partialSecrets.loginKey)
    }
  }, [])

  const addPasswordWrapper = useCallback(async (password: string, iterations: number) => {
    if (!user?.identityId) {
      throw new Error('You must be logged in to add a password unlock method.')
    }

    const { wrapDekWithPassword } = await import('@/lib/crypto/auth-vault')
    const { authVaultAccessService } = await import('@/lib/services/auth-vault-access-service')

    try {
      const ensured = await ensureVaultForCurrentSession(user.identityId)
      const wrapped = await wrapDekWithPassword(ensured.dek, password, iterations, user.identityId, ensured.vault.$id)

      await authVaultAccessService.upsertPasswordAccess(user.identityId, {
        vaultId: ensured.vault.$id,
        label: 'Password',
        wrappedDek: wrapped.wrappedDek,
        iv: wrapped.iv,
        pbkdf2Salt: wrapped.pbkdf2Salt,
        pbkdf2Iterations: iterations,
      })
    } catch (error) {
      throw toFriendlyVaultWriteError(error, 'password')
    }
  }, [ensureVaultForCurrentSession, user?.identityId])

  const addPasskeyWrapper = useCallback(async (label = 'Current device') => {
    if (!user?.identityId) {
      throw new Error('You must be logged in to add a passkey.')
    }

    const { createPasskeyWithPrf } = await import('@/lib/webauthn/passkey-prf')
    const { wrapDekWithPrf } = await import('@/lib/crypto/auth-vault')
    const { authVaultAccessService } = await import('@/lib/services/auth-vault-access-service')

    try {
      const ensured = await ensureVaultForCurrentSession(user.identityId)
      const username = user.dpnsUsername || user.identityId
      const passkey = await createPasskeyWithPrf({
        identityId: user.identityId,
        username,
        displayName: username,
        label,
      })

      const wrapped = await wrapDekWithPrf(ensured.dek, passkey.prfOutput, user.identityId, ensured.vault.$id, passkey.rpId)

      try {
        await authVaultAccessService.createPasskeyAccess(user.identityId, {
          vaultId: ensured.vault.$id,
          label: passkey.label,
          wrappedDek: wrapped.wrappedDek,
          iv: wrapped.iv,
          credentialId: passkey.credentialId,
          credentialIdHash: passkey.credentialIdHash,
          prfInput: passkey.prfInput,
          rpId: passkey.rpId,
        })
      } catch (error) {
        const existingAccesses = await authVaultAccessService.getPasskeyAccesses(user.identityId).catch(() => [])
        if (existingAccesses.some((access) => sameBytes(access.credentialIdHash, passkey.credentialIdHash))) {
          return
        }

        throw error
      }
    } catch (error) {
      throw toFriendlyVaultWriteError(error, 'passkey')
    }
  }, [ensureVaultForCurrentSession, user?.dpnsUsername, user?.identityId])

  const logout = useCallback(async () => {
    localStorage.removeItem('yappr_session')
    sessionStorage.removeItem('yappr_dpns_username')
    sessionStorage.removeItem('yappr_skip_dpns')
    sessionStorage.removeItem('yappr_backup_prompt_shown')

    // Clear private key, encryption key, transfer key, and caches
    if (user?.identityId) {
      const {
        clearPrivateKey,
        clearEncryptionKey,
        clearEncryptionKeyType,
        clearTransferKey,
        clearLoginKey,
        clearAuthVaultDek,
      } = await import('@/lib/secure-storage')
      clearPrivateKey(user.identityId)
      clearEncryptionKey(user.identityId)
      clearEncryptionKeyType(user.identityId)
      clearTransferKey(user.identityId)
      clearLoginKey(user.identityId)
      clearAuthVaultDek(user.identityId)

      const { invalidateBlockCache } = await import('@/lib/caches/block-cache')
      invalidateBlockCache(user.identityId)

      // Clear all private feed keys (both owner keys and followed feed keys)
      const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
      privateFeedKeyStore.clearAllKeys()
    }

    setUser(null)

    // Clear DashPlatformClient identity
    setDashPlatformClientIdentity('')

    router.push('/login')
  }, [router, user?.identityId])

  const loginWithPassword = useCallback(async (username: string, password: string) => {
    setIsLoading(true)
    setError(null)

    try {
      let result: { identityId: string; privateKey: string } | null = null

      // Try unified auth vault first.
      const { authVaultService } = await import('@/lib/services/auth-vault-service')
      if (authVaultService.isConfigured()) {
        try {
          const unlocked = await authVaultService.unlockWithPassword(username, password)
          await restoreUnlockedVaultSession(unlocked)
          return
        } catch (authVaultErr) {
          const msg = authVaultErr instanceof Error ? authVaultErr.message : ''
          if (msg === 'Invalid password') {
            throw authVaultErr
          }
          logger.info('Auth: Unified auth vault login failed, falling back to legacy contracts:', msg || authVaultErr)
        }
      }

      // Try legacy vault service next.
      const { vaultService } = await import('@/lib/services/vault-service')
      if (vaultService.isConfigured()) {
        try {
          result = await vaultService.loginWithPassword(username, password)
        } catch (vaultErr) {
          const msg = vaultErr instanceof Error ? vaultErr.message : ''
          if (msg === 'Invalid password') {
            throw vaultErr
          }
          logger.info('Auth: Legacy vault login failed, falling back to old encrypted-key-backup contract:', msg || vaultErr)
        }
      }

      // Fall back to the oldest encrypted-key-backup contract.
      if (!result) {
        const { encryptedKeyService } = await import('@/lib/services/encrypted-key-service')
        if (!encryptedKeyService.isConfigured()) {
          throw new Error('Password login is not yet configured')
        }
        const oldResult = await encryptedKeyService.loginWithPassword(username, password)
        result = { identityId: oldResult.identityId, privateKey: oldResult.privateKey }
      }

      // Continue with normal login flow using decrypted credentials
      // Skip username check since we know they have one (they logged in with it)
      await login(result.identityId, result.privateKey, { skipUsernameCheck: true })
    } catch (err) {
      logger.error('Password login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login with password')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [login, restoreUnlockedVaultSession])

  const loginWithPasskey = useCallback(async (identityOrUsername?: string) => {
    setIsLoading(true)
    setError(null)

    try {
      const { authVaultService } = await import('@/lib/services/auth-vault-service')
      const { authVaultAccessService } = await import('@/lib/services/auth-vault-access-service')
      const { getDefaultRpId, getPrfAssertionForCredentials, selectDiscoverablePasskey } = await import('@/lib/webauthn/passkey-prf')

      if (!authVaultService.isConfigured()) {
        throw new Error('Passkey login is not configured')
      }

      const normalizedIdentity = identityOrUsername?.trim()
      const currentRpId = getDefaultRpId()
      let accesses = [] as Awaited<ReturnType<typeof authVaultAccessService.getPasskeyAccesses>>
      let selectedCredentialHash: Uint8Array | undefined

      if (normalizedIdentity) {
        const identityId = await authVaultService.resolveIdentityId(normalizedIdentity)
        if (!identityId) {
          throw new Error('Username not found')
        }

        accesses = (await authVaultAccessService.getPasskeyAccesses(identityId)).filter((access) => access.rpId === currentRpId)
      } else {
        const selectedPasskey = await selectDiscoverablePasskey(currentRpId)
        if (!selectedPasskey.userHandle) {
          throw new Error('This passkey did not provide an account identifier. Try signing in with your username once, then use passkey login again.')
        }

        accesses = (await authVaultAccessService.getPasskeyAccesses(selectedPasskey.userHandle)).filter((access) => access.rpId === currentRpId)
        selectedCredentialHash = selectedPasskey.credentialIdHash
      }

      if (accesses.length === 0) {
        if (normalizedIdentity) {
          throw new Error('No passkey login is configured for this site and account')
        }
        throw new Error('No passkey login is configured for this selected passkey on this site yet')
      }

      if (selectedCredentialHash) {
        accesses = accesses.filter((access) => sameBytes(access.credentialIdHash, selectedCredentialHash))
        if (accesses.length === 0) {
          throw new Error('This selected passkey is not registered for this site')
        }
      }

      const descriptors = accesses.flatMap((access) => {
        if (!access.credentialId || !access.prfInput || !access.rpId) return []
        return [{
          credentialId: access.credentialId,
          prfInput: access.prfInput,
          rpId: access.rpId,
        }]
      })

      const assertion = await getPrfAssertionForCredentials(descriptors)
      const expectedCredentialHash = selectedCredentialHash ?? assertion.credentialIdHash
      const access = accesses.find((entry) => sameBytes(entry.credentialIdHash, expectedCredentialHash))
      if (!access) {
        throw new Error('Selected passkey is not registered for this site')
      }

      const unlocked = await authVaultService.unlockWithPrf(access.$ownerId, access, assertion.prfOutput)
      await restoreUnlockedVaultSession(unlocked)
    } catch (err) {
      logger.error('Passkey login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login with passkey')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [restoreUnlockedVaultSession])

  /**
   * Login using a key exchange login key from a wallet.
   *
   * This method is called after successful key exchange with a wallet app.
   * It derives auth and encryption keys from the login key and completes login.
   *
   * Spec: YAPPR_DET_SIGNER_SPEC.md sections 5.2, 5.3
   */
  const loginWithKeyExchange = useCallback(async (
    identityId: string,
    loginKey: Uint8Array,
    keyIndex: number
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      // Import key derivation functions
      const { deriveAuthKeyFromLogin, deriveEncryptionKeyFromLogin } = await import('@/lib/crypto/key-exchange')
      const { decodeIdentityId } = await import('@/lib/crypto/key-exchange-uri')
      const { privateKeyToWif } = await import('@/lib/crypto/wif')
      const { storeEncryptionKey, storeEncryptionKeyType, storeLoginKey } = await import('@/lib/secure-storage')

      // Decode identity ID to bytes
      const identityIdBytes = decodeIdentityId(identityId)

      // Derive auth and encryption keys from login key
      const authKey = deriveAuthKeyFromLogin(loginKey, identityIdBytes)
      const encryptionKey = deriveEncryptionKeyFromLogin(loginKey, identityIdBytes)

      // Get network for WIF encoding
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'

      // Convert to WIF format for storage
      const authKeyWif = privateKeyToWif(authKey, network, true)
      const encryptionKeyWif = privateKeyToWif(encryptionKey, network, true)

      storeLoginKey(identityId, loginKey)

      logger.info(`Auth: Key exchange login - keyIndex=${keyIndex}`)

      // Continue with normal login flow (login() stores authKeyWif internally)
      await login(identityId, authKeyWif, { skipUsernameCheck: false })

      // Only persist encryption key after successful login
      storeEncryptionKey(identityId, encryptionKeyWif)
      storeEncryptionKeyType(identityId, 'derived')
      await createOrUpdateUnifiedVaultFromLoginKey(identityId, loginKey).catch((vaultError) => {
        logger.warn('Auth: Failed to create or update unified auth vault after QR login:', vaultError)
      })
      await mergeSecretsIntoAuthVault(identityId, {
        loginKey,
        encryptionKeyWif,
        source: 'wallet-derived',
      }).catch((vaultError) => {
        logger.warn('Auth: Failed to merge QR-derived secrets into auth vault:', vaultError)
      })
    } catch (err) {
      // Clear any partially persisted encryption key and type metadata on failure
      const { clearEncryptionKey, clearEncryptionKeyType, clearLoginKey } = await import('@/lib/secure-storage')
      clearEncryptionKey(identityId)
      clearEncryptionKeyType(identityId)
      clearLoginKey(identityId)

      logger.error('Key exchange login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login with key exchange')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [createOrUpdateUnifiedVaultFromLoginKey, login, mergeSecretsIntoAuthVault])

  const updateDPNSUsername = useCallback((username: string) => {
    if (!user) return

    setUser({ ...user, dpnsUsername: username })
    updateSavedSession(data => { (data.user as Record<string, unknown>).dpnsUsername = username })
  }, [user])

  // Refresh DPNS usernames from the network (fetches primary username)
  const refreshDpnsUsernames = useCallback(async () => {
    const identityId = user?.identityId
    if (!identityId) return

    try {
      const { dpnsService } = await import('@/lib/services/dpns-service')
      dpnsService.clearCache(undefined, identityId)
      const dpnsUsername = await dpnsService.resolveUsername(identityId)

      if (dpnsUsername && dpnsUsername !== user.dpnsUsername) {
        setUser(prev => prev ? { ...prev, dpnsUsername } : prev)
        updateSavedSession(data => { (data.user as Record<string, unknown>).dpnsUsername = dpnsUsername })
      }
    } catch (error) {
      logger.error('Failed to refresh DPNS usernames:', error)
    }
  }, [user?.identityId, user?.dpnsUsername])

  // Refresh balance from the network (clears cache first)
  const refreshBalance = useCallback(async () => {
    const identityId = user?.identityId
    if (!identityId) return

    try {
      const { identityService } = await import('@/lib/services/identity-service')
      identityService.clearCache(identityId)
      const balance = await identityService.getBalance(identityId)

      setUser(prev => prev ? { ...prev, balance: balance.confirmed } : prev)
      updateSavedSession(data => { (data.user as Record<string, unknown>).balance = balance.confirmed })
    } catch (error) {
      logger.error('Failed to refresh balance:', error)
    }
  }, [user?.identityId])

  // Periodic balance refresh (every 5 minutes when user is logged in)
  useEffect(() => {
    const identityId = user?.identityId
    if (!identityId) return

    const FIVE_MINUTES = 300000

    const interval = setInterval(async () => {
      try {
        const { identityService } = await import('@/lib/services/identity-service')
        identityService.clearCache(identityId)
        const balance = await identityService.getBalance(identityId)
        setUser(prev => prev ? { ...prev, balance: balance.confirmed } : prev)
        updateSavedSession(data => { (data.user as Record<string, unknown>).balance = balance.confirmed })
      } catch (error) {
        logger.error('Failed to refresh balance:', error)
      }
    }, FIVE_MINUTES)

    return () => clearInterval(interval)
  }, [user?.identityId])

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthRestoring,
      error,
      login,
      loginWithPassword,
      loginWithPasskey,
      loginWithKeyExchange,
      createOrUpdateUnifiedVaultFromLoginKey,
      createOrUpdateUnifiedVaultFromAuthKey,
      addPasskeyWrapper,
      addPasswordWrapper,
      mergeSecretsIntoAuthVault,
      logout,
      updateDPNSUsername,
      refreshDpnsUsernames,
      refreshBalance
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

// HOC for protecting routes
export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
  options?: {
    allowWithoutProfile?: boolean
    allowWithoutDPNS?: boolean
    optional?: boolean  // Allow access without authentication
  }
): React.ComponentType<P> {
  function AuthenticatedComponent(props: P): JSX.Element {
    const { user, isAuthRestoring } = useAuth()
    const router = useRouter()

    const skipDPNS = typeof window !== 'undefined'
      && sessionStorage.getItem('yappr_skip_dpns') === 'true'
    const needsDPNS = !options?.allowWithoutDPNS && user && !user.dpnsUsername && !skipDPNS

    useEffect(() => {
      // Wait for session restoration to complete before checking auth
      if (isAuthRestoring) return

      logger.info('withAuth check - user:', user)

      // Handle missing user
      if (!user) {
        if (options?.optional) {
          logger.info('No user found, but auth is optional - continuing...')
          return
        }
        logger.info('No user found, redirecting to login...')
        router.push('/login')
        return
      }

      // Handle missing DPNS username
      if (needsDPNS) {
        logger.info('No DPNS username found, redirecting to DPNS registration...')
        router.push('/dpns/register')
      }
    }, [user, isAuthRestoring, router, needsDPNS])

    // Show loading while restoring auth
    if (isAuthRestoring) {
      return <AuthLoadingSpinner />
    }

    // Optional auth: render regardless of user state
    if (options?.optional) {
      return <Component {...props} />
    }

    // Required auth: show loading while redirecting
    if (!user || needsDPNS) {
      return <AuthLoadingSpinner />
    }

    return <Component {...props} />
  }

  return AuthenticatedComponent
}
