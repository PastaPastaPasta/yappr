'use client'

import { logger } from '@/lib/logger'
import { hasSkippedUsername } from '@/lib/username-skip'
import { signInDestination } from '@/lib/auth/intent-destination'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { usePathname, useRouter } from 'next/navigation'
import { PlatformAuthController, SupersededSignInError, type AppConnectGrant, type AuthUser as PlatformAuthUser, type PlatformAuthIntent } from 'platform-auth'
import { createYapprPlatformAuthDependencies } from '@/lib/auth/platform-auth-adapters'
import { currentRoute, dpnsRegisterHref } from '@/lib/auth/return-to'
import { keyNetwork } from '@/lib/constants'
import { keyValidationService } from '@/lib/services/key-validation-service'
import { useUsernameModal } from '@/hooks/use-username-modal'
import { useLoginModal } from '@/hooks/use-login-modal'
import { appConnectSessions, useAppConnectStatus } from '@/lib/app-connect/session-manager'
import { settleHeldRevoke, type HeldRevoke } from '@/lib/app-connect/held-revoke'
import { createWalletSignIn, wipeGrant } from '@/lib/app-connect/wallet-sign-in'
import { restorePasskeyMessagingKey, unlockWithPasskey, type PasskeyRenewal } from '@/lib/auth/passkey-vault'
import { clearPasskeyCriticalKey, markPasskeyCriticalKey, unmarkPasskeyCriticalKey } from '@/lib/auth/passkey-device'
import { usePasskeyPrompts, type SignInMethod } from '@/hooks/use-passkey-prompts'

/**
 * A sign-in finished (not a restore): the passkey prompts decide whether to
 * offer one or ask to update them, bound to the session `epoch` it left.
 */
function noteSignIn(intent: PlatformAuthIntent, method: SignInMethod, epoch: number): void {
  // A username prompt still means a signed-in session: the passkey dialogs wait for it to close.
  if (intent.kind !== 'logged-out') usePasskeyPrompts.getState().noteSignIn(intent.identityId, method, epoch)
}

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
  /**
   * Signs in with a passkey: the browser's picker, then the session the passkey
   * holds (docs/PASSKEY_VAULT.md). Resolves null once signed in, or with the
   * identity whose wallet sign-in needs renewing first. Rejects with a
   * PasskeyVaultError when the passkey cannot sign in.
   */
  loginWithPasskey: () => Promise<PasskeyRenewal | null>
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

  /** Wallet sign-ins and renewals, one at a time and bound to the session they began on (#734). */
  const walletSignIn = useMemo(() => createWalletSignIn({
    controller,
    sessions: appConnectSessions,
    settled: async () => { await revokeLogout.current },
  }), [controller])
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
    const next = signInDestination(intent)
    if (next.kind === 'username-prompt') useUsernameModal.getState().open(next.identityId)
    else router.push(next.href)
  }, [router])

  /**
   * `since`: the session epoch the sign-in began on; any sign-in or sign-out
   * after it supersedes this one. Defaults to now.
   */
  const signInWithKey = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean; since?: number } = {}): Promise<PlatformAuthIntent> => {
    // Taken before the key check: a sign-in or sign-out while it runs supersedes this one.
    const since = options.since ?? controller.sessionEpoch()
    // The same rule restore and signing apply, on keys read fresh: a disabled or wrong-level key never starts a session.
    const check = await keyValidationService.validatePrivateKey(privateKey, identityId, keyNetwork(), { fresh: true })
    if (!check.isValid) throw new Error(check.error ?? 'This key cannot sign in to this account')
    const result = await controller.loginWithAuthKey(identityId, privateKey, { skipUsernameCheck: options.skipUsernameCheck, since })
    await applyIntent(result.intent)
    return result.intent
  }, [applyIntent, controller])

  const login = useCallback(async (identityId: string, privateKey: string, options: { skipUsernameCheck?: boolean } = {}) => {
    const intent = await signInWithKey(identityId, privateKey, options)
    // Cleared only once the typed key is the session's: a failed sign-in leaves a passkey's CRITICAL key marked.
    clearPasskeyCriticalKey(identityId)
    noteSignIn(intent, 'key', controller.sessionEpoch())
  }, [controller, signInWithKey])

  const signInWithGrant = useCallback(async (grant: AppConnectGrant, since?: number): Promise<PlatformAuthIntent> => {
    const result = await walletSignIn.signIn(grant, since)
    await applyIntent(result.intent)
    return result.intent
  }, [applyIntent, walletSignIn])

  const loginWithAppConnect = useCallback(async (grant: AppConnectGrant) => {
    const intent = await signInWithGrant(grant)
    noteSignIn(intent, 'wallet', controller.sessionEpoch())
    return intent
  }, [controller, signInWithGrant])

  const loginWithPasskey = useCallback(async (): Promise<PasskeyRenewal | null> => {
    // Taken before the passkey picker: a sign-in or sign-out while the passkey opens supersedes it.
    const since = controller.sessionEpoch()
    const unlocked = await unlockWithPasskey()
    switch (unlocked.kind) {
      case 'renew':
        return { identityId: unlocked.identityId, reason: unlocked.reason }
      case 'key-ring':
        if (controller.sessionEpoch() !== since) {
          wipeGrant(unlocked.grant)
          throw new SupersededSignInError()
        }
        noteSignIn(await signInWithGrant(unlocked.grant, since), 'passkey', controller.sessionEpoch())
        return null
      case 'raw-key': {
        // Marked (for this exact key) before it is stored, so it never signs unmarked. A HIGH key clears
        // the marks only once it is the session's.
        const mark = unlocked.critical ? markPasskeyCriticalKey(unlocked.identityId, unlocked.signInWif) : null
        let intent: PlatformAuthIntent
        try {
          intent = await signInWithKey(unlocked.identityId, unlocked.signInWif, { since })
        } catch (error) {
          // Superseded before its commit, this sign-in stored nothing: its own mark goes, and any winner's stays.
          // After a commit the key may be stored, so the mark stays.
          if (mark && (error instanceof SupersededSignInError || controller.getState().user?.identityId !== unlocked.identityId)) {
            unmarkPasskeyCriticalKey(unlocked.identityId, mark)
          }
          throw error
        }
        if (!unlocked.critical) clearPasskeyCriticalKey(unlocked.identityId)
        if (unlocked.messagingWif) restorePasskeyMessagingKey(unlocked.identityId, unlocked.messagingWif)
        noteSignIn(intent, 'passkey', controller.sessionEpoch())
        return null
      }
    }
  }, [controller, signInWithGrant, signInWithKey])

  const renewWithAppConnect = useCallback(async (grant: AppConnectGrant) => {
    // A revocation sign-out may still be running: let it finish first, so it
    // cannot clear the grant adopted here.
    await revokeLogout.current
    if (controller.getState().user) {
      // Only the signed-in identity's own renewal, and only while that session stands.
      await walletSignIn.renew(grant)
      useAppConnectStatus.getState().dismissRenewRequired()
      // The renewal superseded the old wallet keys: passkeys still holding them need updating.
      usePasskeyPrompts.getState().noteSignIn(grant.identityId, 'renewal', controller.sessionEpoch())
      return
    }
    // Signed out meanwhile: the renewal signs back in, and a sign-in prompt that
    // sign-out opened has nothing left to ask.
    await loginWithAppConnect(grant)
    useAppConnectStatus.getState().dismissSignedOut()
    useLoginModal.getState().close()
  }, [controller, loginWithAppConnect, walletSignIn])

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
    loginWithPasskey,
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
    loginWithPasskey,
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

    const skipDPNS = user ? hasSkippedUsername(user.identityId) : false
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
