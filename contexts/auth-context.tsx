'use client'

import { logger } from '@/lib/logger'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useRouter } from 'next/navigation'
import { PlatformAuthController, type AuthUser as PlatformAuthUser, type PlatformAuthIntent } from 'platform-auth'
import { createYapprPlatformAuthDependencies } from '@/lib/auth/platform-auth-adapters'
import { extractErrorMessage, isAlreadyExistsError } from '@/lib/error-utils'
import { useUsernameModal } from '@/hooks/use-username-modal'

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

function AuthLoadingSpinner(): JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <Spinner size="md" />
    </div>
  )
}

function toExternalUser(user: PlatformAuthUser | null): AuthUser | null {
  if (!user) return null

  return {
    identityId: user.identityId,
    balance: user.balance,
    dpnsUsername: user.username,
    publicKeys: user.publicKeys,
  }
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

function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const controller = useMemo(() => new PlatformAuthController(createYapprPlatformAuthDependencies()), [])
  const [controllerState, setControllerState] = useState(() => controller.getState())

  useEffect(() => controller.subscribe(setControllerState), [controller])

  useEffect(() => {
    controller.restoreSession().catch((error) => {
      logger.error('Auth: Failed to restore session:', error)
    })

    return () => {
      controller.dispose()
    }
  }, [controller])

  const applyIntent = useCallback(async (intent: PlatformAuthIntent): Promise<void> => {
    switch (intent.kind) {
      case 'username-required':
        useUsernameModal.getState().open(intent.identityId)
        return
      case 'profile-required':
        router.push('/profile/create')
        return
      case 'ready':
        router.push('/feed')
        return
      case 'logged-out':
        router.push('/login')
        return
    }
  }, [router])

  const login = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean } = {}) => {
    const result = await controller.loginWithAuthKey(identityId, privateKey, options)
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const loginWithPassword = useCallback(async (username: string, password: string) => {
    const result = await controller.loginWithPassword(username, password)
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const loginWithPasskey = useCallback(async (identityOrUsername?: string) => {
    const result = await controller.loginWithPasskey(identityOrUsername)
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const loginWithKeyExchange = useCallback(async (identityId: string, loginKey: Uint8Array, keyIndex: number) => {
    const result = await controller.loginWithLoginKey(identityId, loginKey, keyIndex)
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const createOrUpdateUnifiedVaultFromLoginKey = useCallback(async (identityId: string, loginKey: Uint8Array) => {
    await controller.createOrUpdateVaultFromLoginKey(identityId, loginKey)
  }, [controller])

  const createOrUpdateUnifiedVaultFromAuthKey = useCallback(async (identityId: string, authKeyWif: string) => {
    await controller.createOrUpdateVaultFromAuthKey(identityId, authKeyWif)
  }, [controller])

  const mergeSecretsIntoAuthVault = useCallback(async (
    identityId: string,
    partialSecrets: {
      loginKey?: Uint8Array | string
      authKeyWif?: string
      encryptionKeyWif?: string
      transferKeyWif?: string
      source?: 'wallet-derived' | 'direct-key' | 'password-migrated' | 'mixed'
    },
  ) => {
    await controller.mergeSecretsIntoVault(identityId, {
      loginKey: partialSecrets.loginKey
        ? partialSecrets.loginKey instanceof Uint8Array
          ? partialSecrets.loginKey
          : decodeBase64ToBytes(partialSecrets.loginKey)
        : undefined,
      authKeyWif: partialSecrets.authKeyWif,
      encryptionKeyWif: partialSecrets.encryptionKeyWif,
      transferKeyWif: partialSecrets.transferKeyWif,
      source: partialSecrets.source,
    })
  }, [controller])

  const addPasswordWrapper = useCallback(async (password: string, iterations: number) => {
    try {
      await controller.addPasswordAccess(password, iterations)
    } catch (error) {
      throw toFriendlyVaultWriteError(error, 'password')
    }
  }, [controller])

  const addPasskeyWrapper = useCallback(async (label = 'Current device') => {
    try {
      await controller.addPasskeyAccess(label)
    } catch (error) {
      throw toFriendlyVaultWriteError(error, 'passkey')
    }
  }, [controller])

  const logout = useCallback(async () => {
    const result = await controller.logout()
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const updateDPNSUsername = useCallback((username: string) => {
    controller.setUsername(username).catch((error) => {
      logger.error('Failed to update DPNS username:', error)
    })
  }, [controller])

  const refreshDpnsUsernames = useCallback(async () => {
    await controller.refreshUsername()
  }, [controller])

  const refreshBalance = useCallback(async () => {
    await controller.refreshBalance()
  }, [controller])

  const value = useMemo<AuthContextType>(() => ({
    user: toExternalUser(controllerState.user),
    isLoading: controllerState.isLoading,
    isAuthRestoring: controllerState.isAuthRestoring,
    error: controllerState.error,
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
    refreshBalance,
  }), [
    addPasskeyWrapper,
    addPasswordWrapper,
    controllerState.error,
    controllerState.isAuthRestoring,
    controllerState.isLoading,
    controllerState.user,
    createOrUpdateUnifiedVaultFromAuthKey,
    createOrUpdateUnifiedVaultFromLoginKey,
    login,
    loginWithKeyExchange,
    loginWithPasskey,
    loginWithPassword,
    logout,
    mergeSecretsIntoAuthVault,
    refreshBalance,
    refreshDpnsUsernames,
    updateDPNSUsername,
  ])

  return (
    <AuthContext.Provider value={value}>
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

export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
  options?: {
    allowWithoutProfile?: boolean
    allowWithoutDPNS?: boolean
    optional?: boolean
  }
): React.ComponentType<P> {
  function AuthenticatedComponent(props: P): JSX.Element {
    const { user, isAuthRestoring } = useAuth()
    const router = useRouter()

    const skipDPNS = typeof window !== 'undefined'
      && sessionStorage.getItem('yappr_skip_dpns') === 'true'
    const needsDPNS = !options?.allowWithoutDPNS && user && !user.dpnsUsername && !skipDPNS

    useEffect(() => {
      if (isAuthRestoring) return

      if (!user) {
        if (options?.optional) {
          return
        }
        router.push('/login')
        return
      }

      if (needsDPNS) {
        router.push('/dpns/register')
      }
    }, [user, isAuthRestoring, router, needsDPNS, options?.optional])

    if (isAuthRestoring) {
      return <AuthLoadingSpinner />
    }

    if (options?.optional) {
      return <Component {...props} />
    }

    if (!user || needsDPNS) {
      return <AuthLoadingSpinner />
    }

    return <Component {...props} />
  }

  return AuthenticatedComponent
}
