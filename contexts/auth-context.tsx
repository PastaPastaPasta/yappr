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
    type: string
    purpose: string
    securityLevel: string
  }>
}

interface AuthContextType {
  user: AuthUser | null
  isLoading: boolean
  isAuthRestoring: boolean
  error: string | null
  login: (identityId: string, privateKey: string, options?: { skipUsernameCheck?: boolean; rememberMe?: boolean }) => Promise<void>
  loginWithPassword: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  logout: () => void
  updateDPNSUsername: (username: string) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isAuthRestoring, setIsAuthRestoring] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  // Check for saved session on mount
  useEffect(() => {
    const restoreSession = async () => {
      const savedSession = localStorage.getItem('yappr_session')
      if (savedSession) {
        try {
          const sessionData = JSON.parse(savedSession)
          const savedUser = sessionData.user
          
          // Set user immediately with cached data
          setUser(savedUser)
          
          // Set identity in DashPlatformClient for document operations
          try {
            const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
            const dashClient = getDashPlatformClient()
            dashClient.setIdentity(savedUser.identityId)
            console.log('Auth: DashPlatformClient identity restored from session')
          } catch (err) {
            console.error('Auth: Failed to set DashPlatformClient identity:', err)
          }
          
          // If user doesn't have DPNS username, fetch it in background
          if (savedUser && !savedUser.dpnsUsername) {
            console.log('Auth: Fetching DPNS username in background...')
            // Don't await - let it happen in background
            import('@/lib/services/dpns-service').then(async ({ dpnsService }) => {
              try {
                const dpnsUsername = await dpnsService.resolveUsername(savedUser.identityId)
                if (dpnsUsername) {
                  console.log('Auth: Found DPNS username:', dpnsUsername)
                  // Update user state
                  setUser(prev => prev ? { ...prev, dpnsUsername } : prev)
                  // Update saved session
                  const updatedSession = { ...sessionData, user: { ...savedUser, dpnsUsername } }
                  localStorage.setItem('yappr_session', JSON.stringify(updatedSession))
                }
              } catch (e) {
                console.error('Auth: Background DPNS fetch failed:', e)
              }
            })
          }

          // Initialize block data on session restore (background)
          import('@/lib/services/block-service').then(async ({ blockService }) => {
            try {
              await blockService.initializeBlockData(savedUser.identityId)
              console.log('Auth: Block data initialized from session restore')
            } catch (err) {
              console.error('Auth: Failed to initialize block data:', err)
            }
          })

          // Check for Dash Pay contacts on session restore (delayed)
          setTimeout(async () => {
            try {
              const { dashPayContactsService } = await import('@/lib/services/dashpay-contacts-service')
              const result = await dashPayContactsService.getUnfollowedContacts(savedUser.identityId)

              if (result.contacts.length > 0) {
                const { useDashPayContactsModal } = await import('@/hooks/use-dashpay-contacts-modal')
                useDashPayContactsModal.getState().open()
              }
            } catch (err) {
              console.error('Auth: Failed to check Dash Pay contacts:', err)
            }
          }, 3000) // 3 second delay on session restore
        } catch (e) {
          console.error('Failed to restore session:', e)
          localStorage.removeItem('yappr_session')
        }
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
      const { storePrivateKey, setRememberMe } = await import('@/lib/secure-storage')
      setRememberMe(rememberMe)
      storePrivateKey(identityId, privateKey)

      setUser(authUser)
      
      // Set identity in DashPlatformClient for document operations
      try {
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()
        dashClient.setIdentity(identityId)
      } catch (err) {
        console.error('Failed to set DashPlatformClient identity:', err)
      }
      
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
        console.log('Profile found, redirecting to home...')
        router.push('/')

        // Initialize block data after login (background, don't block navigation)
        import('@/lib/services/block-service').then(async ({ blockService }) => {
          try {
            await blockService.initializeBlockData(authUser.identityId)
            console.log('Auth: Block data initialized after login')
          } catch (err) {
            console.error('Auth: Failed to initialize block data:', err)
          }
        })

        // Check for Dash Pay contacts after login (delayed to not block navigation)
        setTimeout(async () => {
          try {
            const { dashPayContactsService } = await import('@/lib/services/dashpay-contacts-service')
            const result = await dashPayContactsService.getUnfollowedContacts(authUser.identityId)

            if (result.contacts.length > 0) {
              const { useDashPayContactsModal } = await import('@/hooks/use-dashpay-contacts-modal')
              useDashPayContactsModal.getState().open()
            }
          } catch (err) {
            console.error('Auth: Failed to check Dash Pay contacts:', err)
            // Silent failure - don't block user experience
          }
        }, 2000)
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

    // Clear private key from secure storage
    if (user?.identityId) {
      const { clearPrivateKey } = await import('@/lib/secure-storage')
      clearPrivateKey(user.identityId)

      // Clear block cache
      const { invalidateBlockCache } = await import('@/lib/caches/block-cache')
      invalidateBlockCache(user.identityId)
    }

    setUser(null)

    // Clear DashPlatformClient identity
    import('@/lib/dash-platform-client').then(({ getDashPlatformClient }) => {
      const dashClient = getDashPlatformClient()
      dashClient.setIdentity('')
    })

    router.push('/login')
  }, [router])

  const loginWithPassword = useCallback(async (username: string, password: string, rememberMe = false) => {
    setIsLoading(true)
    setError(null)

    try {
      // Use the encrypted key service to decrypt credentials
      const { encryptedKeyService } = await import('@/lib/services/encrypted-key-service')

      if (!encryptedKeyService.isConfigured()) {
        throw new Error('Password login is not yet configured')
      }

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

  const updateDPNSUsername = useCallback((username: string) => {
    if (user) {
      const updatedUser = { ...user, dpnsUsername: username }
      setUser(updatedUser)
      
      // Update session storage
      const savedSession = localStorage.getItem('yappr_session')
      if (savedSession) {
        try {
          const sessionData = JSON.parse(savedSession)
          sessionData.user.dpnsUsername = username
          localStorage.setItem('yappr_session', JSON.stringify(sessionData))
        } catch (e) {
          console.error('Failed to update session:', e)
        }
      }
    }
  }, [user])

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthRestoring,
      error,
      login,
      loginWithPassword,
      logout,
      updateDPNSUsername
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
) {
  return function AuthenticatedComponent(props: P) {
    const { user, isAuthRestoring } = useAuth()
    const router = useRouter()

    useEffect(() => {
      // Wait for session restoration to complete before checking auth
      if (isAuthRestoring) return

      console.log('withAuth check - user:', user)
      if (!user) {
        if (options?.optional) {
          console.log('No user found, but auth is optional - continuing...')
          return
        }
        console.log('No user found, redirecting to login...')
        router.push('/login')
        return
      }

      // Check if user has DPNS username (unless explicitly allowed without)
      const skipDPNS = sessionStorage.getItem('yappr_skip_dpns') === 'true'
      if (!options?.allowWithoutDPNS && !user.dpnsUsername && !skipDPNS) {
        console.log('No DPNS username found, redirecting to DPNS registration...')
        router.push('/dpns/register')
        return
      }
    }, [user, isAuthRestoring, router])

    // Show loading while restoring auth state
    if (isAuthRestoring) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
        </div>
      )
    }

    // If auth is optional, render component even without user
    if (options?.optional) {
      return <Component {...props} />
    }

    // If auth is required and no user, show loading (redirect will happen from useEffect)
    if (!user) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
        </div>
      )
    }

    // If DPNS is required but not present, show loading (redirect will happen)
    const skipDPNS = sessionStorage.getItem('yappr_skip_dpns') === 'true'
    if (!options?.allowWithoutDPNS && !user.dpnsUsername && !skipDPNS) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
        </div>
      )
    }

    return <Component {...props} />
  }
}