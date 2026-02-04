'use client'

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'

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
  login: (identityId: string, privateKey: string, options?: { skipUsernameCheck?: boolean; rememberMe?: boolean }) => Promise<void>
  loginWithPassword: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  loginWithKeyExchange: (identityId: string, loginKey: Uint8Array, keyIndex: number, options?: { rememberMe?: boolean }) => Promise<void>
  logout: () => void
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
    console.error('Failed to update session:', e)
  }
}

// Helper to set DashPlatformClient identity
async function setDashPlatformClientIdentity(identityId: string): Promise<void> {
  try {
    const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
    const dashClient = getDashPlatformClient()
    dashClient.setIdentity(identityId)
  } catch (err) {
    console.error('Failed to set DashPlatformClient identity:', err)
  }
}

// Helper to initialize post-login background tasks (block data + DashPay contacts + private feed sync)
function initializePostLoginTasks(identityId: string, delayMs: number): void {
  // Initialize block data immediately (background)
  import('@/lib/services/block-service').then(async ({ blockService }) => {
    try {
      await blockService.initializeBlockData(identityId)
      console.log('Auth: Block data initialized')
    } catch (err) {
      console.error('Auth: Failed to initialize block data:', err)
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
      console.log('Auth: Skipping private feed sync - session no longer active')
      return
    }

    try {
      const result = await privateFeedFollowerService.syncFollowedFeeds()

      // Check session after sync completes (results already stored by service)
      if (!isSessionActive()) {
        console.log('Auth: Private feed sync completed but session ended - clearing keys')
        const { privateFeedKeyStore } = await import('@/lib/services/private-feed-key-store')
        privateFeedKeyStore.clearAllKeys()
        return
      }

      if (result.synced.length > 0 || result.failed.length > 0) {
        console.log(`Auth: Private feed sync complete - synced: ${result.synced.length}, failed: ${result.failed.length}, up-to-date: ${result.upToDate.length}`)
      }
    } catch (err) {
      console.error('Auth: Failed to sync private feed keys:', err)
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
      console.error('Auth: Failed to check Dash Pay contacts:', err)
    }
  }, delayMs)
}

// Loading spinner shown during auth state transitions
function AuthLoadingSpinner(): JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
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
    const { storeEncryptionKey, storeEncryptionKeyType } = await import('@/lib/secure-storage')
    const { privateKeyToWif } = await import('@/lib/crypto/wif')

    // Derive the encryption key
    const derivedKey = deriveEncryptionKey(authPrivateKey, identityId)

    // Check if it matches the identity's key
    const matches = await validateDerivedKeyMatchesIdentity(derivedKey, identityId, 1)

    if (matches) {
      // Check if session is still active before storing keys
      // This prevents resurrecting keys after logout
      if (!isSessionActive()) {
        console.log('Auth: Session ended before key derivation completed, skipping storage')
        return null
      }

      // Convert to WIF and store
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
      const wif = privateKeyToWif(derivedKey, network, true)
      storeEncryptionKey(identityId, wif)
      storeEncryptionKeyType(identityId, 'derived')
      console.log('Auth: Encryption key derived and stored')
      return derivedKey
    }

    return null
  } catch (error) {
    console.error('Auth: Failed to derive encryption key:', error)
    return null
  }
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

        // Set user immediately with cached data
        setUser(savedUser)

        // Set identity in DashPlatformClient for document operations
        await setDashPlatformClientIdentity(savedUser.identityId)
        console.log('Auth: DashPlatformClient identity restored from session')

        // If user doesn't have DPNS username, fetch it in background
        if (savedUser && !savedUser.dpnsUsername) {
          console.log('Auth: Fetching DPNS username in background...')
          import('@/lib/services/dpns-service').then(async ({ dpnsService }) => {
            try {
              const dpnsUsername = await dpnsService.resolveUsername(savedUser.identityId)
              if (dpnsUsername) {
                console.log('Auth: Found DPNS username:', dpnsUsername)
                setUser(prev => prev ? { ...prev, dpnsUsername } : prev)
                updateSavedSession(data => { (data.user as Record<string, unknown>).dpnsUsername = dpnsUsername })
              }
            } catch (e) {
              console.error('Auth: Background DPNS fetch failed:', e)
            }
          })
        }

        // Initialize background tasks (block data + DashPay contacts)
        initializePostLoginTasks(savedUser.identityId, 3000)
      } catch (e) {
        console.error('Failed to restore session:', e)
        localStorage.removeItem('yappr_session')
      }
    }

    restoreSession().finally(() => {
      setIsAuthRestoring(false)
    })
  }, [])

  const login = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean; rememberMe?: boolean } = {}) => {
    const { skipUsernameCheck = false, rememberMe = false } = options
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

      console.log('Fetching identity with EvoSDK...')
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

      // Set storage mode based on "remember me" choice
      // - rememberMe=true: localStorage (shared across tabs, persists)
      // - rememberMe=false: sessionStorage (single tab, cleared on close)
      const { storePrivateKey, setRememberMe, hasEncryptionKey } = await import('@/lib/secure-storage')
      setRememberMe(rememberMe)
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
          const hasEncryptionKeyOnIdentity = authUser.publicKeys.some(
            (key) => key.purpose === 1 && key.type === 0
          )

          if (hasEncryptionKeyOnIdentity && !hasEncryptionKey(identityId)) {
            // Try to derive encryption key
            // Pass session check callback to prevent storing keys after logout
            console.log('Auth: Attempting encryption key derivation...')
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
              console.log('Auth: Encryption key derivation failed - external key exists on identity')
              // Note: The encryption-key-modal will handle prompting for manual entry
            }
          }
        } catch (err) {
          console.warn('Encryption key derivation failed (non-fatal):', err)
        }
      })()

      // First check if user has DPNS username (unless skipped)
      console.log('Checking for DPNS username...')
      if (!authUser.dpnsUsername && !skipUsernameCheck) {
        console.log('No DPNS username found, opening username modal...')
        // Import and use the username modal store
        const { useUsernameModal } = await import('@/hooks/use-username-modal')
        useUsernameModal.getState().open(identityId)
        return
      }
      
      // Then check if user has a profile (check new unified profile first, then old)
      console.log('Checking for user profile...')
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const { profileService } = await import('@/lib/services/profile-service')
      let profile = await unifiedProfileService.getProfile(identityId, authUser.dpnsUsername)
      if (!profile) {
        // Fall back to old profile service
        profile = await profileService.getProfile(identityId, authUser.dpnsUsername)
      }
      
      if (profile) {
        console.log('Profile found, redirecting to feed...')
        router.push('/feed')

        // Initialize background tasks (block data + DashPay contacts)
        initializePostLoginTasks(authUser.identityId, 2000)
      } else {
        console.log('No profile found, redirecting to profile creation...')
        router.push('/profile/create')
      }
    } catch (err) {
      console.error('Login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [router])

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
      } = await import('@/lib/secure-storage')
      clearPrivateKey(user.identityId)
      clearEncryptionKey(user.identityId)
      clearEncryptionKeyType(user.identityId)
      clearTransferKey(user.identityId)

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

  const loginWithPassword = useCallback(async (username: string, password: string, rememberMe = false) => {
    setIsLoading(true)
    setError(null)

    try {
      // Use the encrypted key service to decrypt credentials
      const { encryptedKeyService } = await import('@/lib/services/encrypted-key-service')

      if (!encryptedKeyService.isConfigured()) {
        throw new Error('Password login is not yet configured')
      }

      // Decrypt credentials from backup
      const result = await encryptedKeyService.loginWithPassword(username, password)

      // Continue with normal login flow using decrypted credentials
      // Skip username check since we know they have one (they logged in with it)
      await login(result.identityId, result.privateKey, { skipUsernameCheck: true, rememberMe })
    } catch (err) {
      console.error('Password login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login with password')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [login])

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
    keyIndex: number,
    options: { rememberMe?: boolean } = {}
  ) => {
    const { rememberMe = true } = options
    setIsLoading(true)
    setError(null)

    try {
      // Import key derivation functions
      const { deriveAuthKeyFromLogin, deriveEncryptionKeyFromLogin } = await import('@/lib/crypto/key-exchange')
      const { decodeIdentityId } = await import('@/lib/crypto/key-exchange-uri')
      const { privateKeyToWif } = await import('@/lib/crypto/wif')
      const { storeEncryptionKey, setRememberMe } = await import('@/lib/secure-storage')

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

      // Set storage mode
      setRememberMe(rememberMe)

      console.log(`Auth: Key exchange login - keyIndex=${keyIndex}`)

      // Continue with normal login flow (login() stores authKeyWif internally)
      await login(identityId, authKeyWif, { skipUsernameCheck: false, rememberMe })

      // Only persist encryption key after successful login
      storeEncryptionKey(identityId, encryptionKeyWif)
    } catch (err) {
      // Clear any partially persisted encryption key on failure
      const { clearEncryptionKey } = await import('@/lib/secure-storage')
      clearEncryptionKey(identityId)

      console.error('Key exchange login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to login with key exchange')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [login])

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
      console.error('Failed to refresh DPNS usernames:', error)
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
      console.error('Failed to refresh balance:', error)
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
        console.error('Failed to refresh balance:', error)
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
      loginWithKeyExchange,
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

      console.log('withAuth check - user:', user)

      // Handle missing user
      if (!user) {
        if (options?.optional) {
          console.log('No user found, but auth is optional - continuing...')
          return
        }
        console.log('No user found, redirecting to login...')
        router.push('/login')
        return
      }

      // Handle missing DPNS username
      if (needsDPNS) {
        console.log('No DPNS username found, redirecting to DPNS registration...')
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