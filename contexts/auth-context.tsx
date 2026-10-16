'use client'

import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { usePathname, useRouter } from 'next/navigation'
import { PlatformAuthController, clearSensitiveBytes, type AppConnectGrant, type AuthUser as PlatformAuthUser, type PlatformAuthIntent } from 'platform-auth'
import { createYapprPlatformAuthDependencies } from '@/lib/auth/platform-auth-adapters'
import { currentRoute, dpnsRegisterHref } from '@/lib/auth/return-to'
import { keyNetwork } from '@/lib/constants'
import { keyValidationService } from '@/lib/services/key-validation-service'
import { useUsernameModal } from '@/hooks/use-username-modal'
import { useLoginModal } from '@/hooks/use-login-modal'
import { appConnectSessions, useAppConnectStatus } from '@/lib/app-connect/session-manager'
import { settleHeldRevoke, type HeldRevoke } from '@/lib/app-connect/held-revoke'

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
  controller: PlatformAuthController
  user: AuthUser | null
  isLoading: boolean
  isAuthRestoring: boolean
  error: string | null
  /** Signs in with a typed-in key; refuses one that is not an enabled CRITICAL or HIGH authentication key of the identity. */
  login: (identityId: string, privateKey: string, options?: { skipUsernameCheck?: boolean }) => Promise<void>
  /** Signs in with a verified App Connect grant (the user already confirmed the identity). Wipes the grant's keys. */
  loginWithAppConnect: (grant: AppConnectGrant) => Promise<PlatformAuthIntent>
  /** Replaces the signed-in identity's App Connect keys with a renewed grant from the same identity. */
  renewWithAppConnect: (grant: AppConnectGrant) => Promise<void>
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const controller = useMemo(() => new PlatformAuthController(createYapprPlatformAuthDependencies()), [])
  const [controllerState, setControllerState] = useState(() => controller.getState())

  useEffect(() => controller.subscribe(setControllerState), [controller])

  /** A sign-out caused by a wallet revoke, while it runs: a grant adopted meanwhile waits for it. */
  const revokeLogout = useRef<Promise<void> | null>(null)
  /**
   * A revoke a renewal under way held back, with the session it was found on;
   * settled once that renewal ends, and dropped if another session replaced that one.
   */
  const deferredRevoke = useRef<HeldRevoke | null>(null)

  // The wallet revoked this browser's App Connect keys: end the session here too,
  // if this tab is still signed in as that identity.
  const signOutRevoked = useCallback((identityId: string) => {
    if (controller.getState().user?.identityId !== identityId) return
    // A newer grant for this identity became active while the old one was
    // being signed out (another tab renewed, or the renewal here landed): it stands.
    if (appConnectSessions.current(identityId)) {
      useAppConnectStatus.getState().dismissSignedOut()
      return
    }
    // The wallet disables the old keys before the renewal's grant arrives, so a
    // revoke found while this identity renews is that renewal: its outcome decides (#738).
    if (useAppConnectStatus.getState().renewing === identityId) {
      deferredRevoke.current = { identityId, epoch: controller.sessionEpoch() }
      return
    }
    revokeLogout.current = controller.logout()
      .then(() => router.push('/'))
      .catch((error) => logger.error('Auth: sign-out after a wallet revoke failed:', error))
  }, [controller, router])

  useEffect(() => {
    appConnectSessions.onSignedOut(signOutRevoked)
    // The renewal a revoke waited for ended, with a new grant or abandoned: settle the revoke now.
    const unsubscribe = useAppConnectStatus.subscribe((state, previous) => {
      const held = deferredRevoke.current
      if (!held) return
      const outcome = settleHeldRevoke(held, previous.renewing, state.renewing, controller.sessionEpoch())
      if (outcome === 'wait') return
      deferredRevoke.current = null
      if (outcome === 'sign-out') signOutRevoked(held.identityId)
      // A sign-in (say, with a typed key) or a sign-out since the revoke: its notice is out of date too.
      else useAppConnectStatus.getState().dismissSignedOut()
    })
    return () => {
      appConnectSessions.onSignedOut(null)
      unsubscribe()
    }
  }, [controller, signOutRevoked])

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
      // The controller's profile gate is off, so `profile-required` never comes.
      case 'profile-required':
      case 'ready':
        router.push('/feed')
        return
      case 'logged-out':
        router.push('/login')
        return
    }
  }, [router])

  const login = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean } = {}) => {
    // The same rule restore and signing apply: a disabled or wrong-level key never starts a session.
    const check = await keyValidationService.validatePrivateKey(privateKey, identityId, keyNetwork())
    if (!check.isValid) throw new Error(check.error ?? 'This key cannot sign in to this account')
    const result = await controller.loginWithAuthKey(identityId, privateKey, options)
    await applyIntent(result.intent)
  }, [applyIntent, controller])

  const loginWithAppConnect = useCallback(async (grant: AppConnectGrant) => {
    await revokeLogout.current
    // Taken before the grant is stored: a sign-in or sign-out while it is
    // stored or while the identity is read supersedes this one.
    const since = controller.sessionEpoch()
    const session = await appConnectSessions.adopt(grant)
    try {
      // Bound to this grant and to the session it started on: if a logout or any
      // other sign-in takes the session meanwhile, this sign-in stores nothing (#734).
      const result = await controller.loginWithKeyRing(session.identityId, {
        since,
        stillCurrent: () => appConnectSessions.current(session.identityId) !== null,
      })
      await applyIntent(result.intent)
      return result.intent
    } catch (error) {
      await appConnectSessions.discard(session)
      throw error
    }
  }, [applyIntent, controller])

  const renewWithAppConnect = useCallback(async (grant: AppConnectGrant) => {
    // A revocation sign-out may still be running: let it finish first, so it
    // cannot clear the grant adopted here.
    await revokeLogout.current
    const identityId = controller.getState().user?.identityId
    if (identityId === grant.identityId) {
      await appConnectSessions.adopt(grant)
      useAppConnectStatus.getState().dismissRenewRequired()
      return
    }
    if (identityId) {
      for (const key of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(key.privateKey)
      throw new Error('The renewal came from another account')
    }
    // Signed out meanwhile: the renewal signs back in, and a sign-in prompt that
    // sign-out opened has nothing left to ask.
    await loginWithAppConnect(grant)
    useAppConnectStatus.getState().dismissSignedOut()
    useLoginModal.getState().close()
  }, [controller, loginWithAppConnect])

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
    controller,
    user: toExternalUser(controllerState.user),
    isLoading: controllerState.isLoading,
    isAuthRestoring: controllerState.isAuthRestoring,
    error: controllerState.error,
    login,
    loginWithAppConnect,
    renewWithAppConnect,
    logout,
    updateDPNSUsername,
    refreshDpnsUsernames,
    refreshBalance,
  }), [
    controller,
    controllerState.error,
    controllerState.isAuthRestoring,
    controllerState.isLoading,
    controllerState.user,
    login,
    loginWithAppConnect,
    logout,
    refreshBalance,
    refreshDpnsUsernames,
    renewWithAppConnect,
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
    optional?: boolean
  }
): React.ComponentType<P> {
  function AuthenticatedComponent(props: P): JSX.Element {
    const { user, isAuthRestoring } = useAuth()
    const router = useRouter()
    const pathname = usePathname()

    const skipDPNS = typeof window !== 'undefined'
      && sessionStorage.getItem(scopedKey('yappr_skip_dpns')) === 'true'
    const needsUsername = Boolean(user && !user.dpnsUsername && !skipDPNS && !options?.optional)

    useEffect(() => {
      if (isAuthRestoring) return

      if (!user) {
        if (options?.optional) {
          return
        }
        router.push('/login')
        return
      }

      if (needsUsername) {
        router.push(dpnsRegisterHref(currentRoute(pathname)))
      }
    }, [user, isAuthRestoring, router, needsUsername, pathname])

    if (isAuthRestoring) {
      return <AuthLoadingSpinner />
    }

    if (options?.optional) {
      return <Component {...props} />
    }

    if (!user || needsUsername) {
      return <AuthLoadingSpinner />
    }

    return <Component {...props} />
  }

  return AuthenticatedComponent
}
