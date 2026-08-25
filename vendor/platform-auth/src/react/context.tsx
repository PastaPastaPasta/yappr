import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { PlatformAuthController } from '../core/controller'
import type { PlatformAuthResult, PlatformAuthState } from '../core/types'

export interface PlatformAuthContextValue extends PlatformAuthState {
  controller: PlatformAuthController
  restoreSession(): Promise<import('../core/types').AuthUser | null>
  loginWithAuthKey(identityId: string, privateKey: string, options?: { skipUsernameCheck?: boolean }): Promise<PlatformAuthResult>
  loginWithPassword(identityOrUsername: string, password: string): Promise<PlatformAuthResult>
  loginWithPasskey(identityOrUsername?: string): Promise<PlatformAuthResult>
  loginWithLoginKey(identityId: string, loginKey: Uint8Array, keyIndex: number): Promise<PlatformAuthResult>
  createOrUpdateVaultFromLoginKey(identityId: string, loginKey: Uint8Array): Promise<import('../core/types').AuthVaultUnlockResult>
  createOrUpdateVaultFromAuthKey(identityId: string, authKeyWif: string): Promise<import('../core/types').AuthVaultUnlockResult>
  addPasswordAccess(password: string, iterations: number, label?: string): Promise<void>
  addPasskeyAccess(label?: string): Promise<void>
  logout(): Promise<PlatformAuthResult>
  setUsername(username: string): Promise<void>
  refreshUsername(): Promise<void>
  refreshBalance(): Promise<void>
}

const PlatformAuthContext = createContext<PlatformAuthContextValue | undefined>(undefined)

export function PlatformAuthProvider({
  controller,
  children,
}: {
  controller: PlatformAuthController
  children: React.ReactNode
}): JSX.Element {
  const [state, setState] = useState<PlatformAuthState>(controller.getState())

  useEffect(() => controller.subscribe(setState), [controller])

  const value = useMemo<PlatformAuthContextValue>(() => ({
    ...state,
    controller,
    restoreSession: controller.restoreSession.bind(controller),
    loginWithAuthKey: controller.loginWithAuthKey.bind(controller),
    loginWithPassword: controller.loginWithPassword.bind(controller),
    loginWithPasskey: controller.loginWithPasskey.bind(controller),
    loginWithLoginKey: controller.loginWithLoginKey.bind(controller),
    createOrUpdateVaultFromLoginKey: controller.createOrUpdateVaultFromLoginKey.bind(controller),
    createOrUpdateVaultFromAuthKey: controller.createOrUpdateVaultFromAuthKey.bind(controller),
    addPasswordAccess: controller.addPasswordAccess.bind(controller),
    addPasskeyAccess: controller.addPasskeyAccess.bind(controller),
    logout: controller.logout.bind(controller),
    setUsername: controller.setUsername.bind(controller),
    refreshUsername: controller.refreshUsername.bind(controller),
    refreshBalance: controller.refreshBalance.bind(controller),
  }), [controller, state])

  return (
    <PlatformAuthContext.Provider value={value}>
      {children}
    </PlatformAuthContext.Provider>
  )
}

export function usePlatformAuth(): PlatformAuthContextValue {
  const value = useContext(PlatformAuthContext)
  if (!value) {
    throw new Error('usePlatformAuth must be used within a PlatformAuthProvider')
  }
  return value
}
