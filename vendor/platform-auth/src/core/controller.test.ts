import { describe, expect, it, vi } from 'vitest'
import { PlatformAuthController, SupersededSignInError } from './controller'
import type { AuthSessionSnapshot, AuthUser, PlatformAuthEvent, SecretStore, UsernamePort } from './types'

const IDENTITY_ID = 'victim-identity'

function setup(resolveUsername: UsernamePort['resolveUsername'], storedUsername?: string) {
  let session: AuthSessionSnapshot | null = {
    user: { identityId: IDENTITY_ID, balance: 1, username: storedUsername, publicKeys: [] },
    timestamp: 0,
  }
  const events: PlatformAuthEvent[] = []
  const storePrivateKey = vi.fn(async () => undefined)
  const clearTabSecrets = vi.fn(async () => undefined)
  const clearPrivateKey = vi.fn(async () => undefined)
  const usernames: UsernamePort = {
    resolveUsername: vi.fn(resolveUsername),
    resolveIdentity: async () => null,
    clearCache: vi.fn(),
  }
  const controller = new PlatformAuthController({
    network: 'testnet',
    sessionStore: {
      getSession: () => session,
      setSession: (snapshot) => {
        session = snapshot
      },
      clearSession: () => {
        session = null
      },
    },
    secretStore: {
      hasPrivateKey: async () => true,
      storePrivateKey,
      clearPrivateKey,
      clearTabSecrets,
      clearEncryptionKey: async () => undefined,
      clearEncryptionKeyType: async () => undefined,
      clearTransferKey: async () => undefined,
      clearLoginKey: async () => undefined,
    } as unknown as SecretStore,
    identity: {
      getIdentity: async (identityId) => ({ id: identityId, balance: 1, publicKeys: [] }),
      getBalance: async () => 1,
    },
    usernames,
    features: { balanceRefresh: false, postLoginTasks: false, autoDeriveEncryptionKey: false },
    onEvent: (event) => {
      events.push(event)
    },
  })
  return {
    controller,
    events,
    usernames,
    storePrivateKey,
    clearPrivateKey,
    clearTabSecrets,
    storedUser: (): AuthUser | undefined => session?.user,
  }
}

describe('PlatformAuthController username sync', () => {
  it('clears a stale stored username on restore when the lookup proves there is none', async () => {
    const { controller, storedUser } = setup(async () => null, 'forged')

    await controller.restoreSession()

    await vi.waitFor(() => expect(controller.getState().user?.username).toBeUndefined())
    expect(storedUser()?.username).toBeUndefined()
  })

  it('replaces a stale stored username on restore with the resolved one', async () => {
    const { controller, storedUser } = setup(async () => 'real.dash', 'forged')

    await controller.restoreSession()

    await vi.waitFor(() => expect(controller.getState().user?.username).toBe('real.dash'))
    expect(storedUser()?.username).toBe('real.dash')
  })

  it('keeps the stored username on restore when the lookup fails', async () => {
    const { controller, events, storedUser } = setup(async () => {
      throw new Error('offline')
    }, 'alice.dash')

    await controller.restoreSession()

    await vi.waitFor(() => expect(events.some((event) => event.type === 'background-error')).toBe(true))
    expect(controller.getState().user?.username).toBe('alice.dash')
    expect(storedUser()?.username).toBe('alice.dash')
  })

  it.each([null, 'other.dash'])('does not let a restore lookup (%s) overwrite a username set while it was in flight', async (answer) => {
    let finish: (username: string | null) => void = () => undefined
    const { controller, storedUser } = setup(() => new Promise((resolve) => {
      finish = resolve
    }), 'forged')

    await controller.restoreSession()
    await controller.setUsername('fresh.dash')
    finish(answer)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(controller.getState().user?.username).toBe('fresh.dash')
    expect(storedUser()?.username).toBe('fresh.dash')
  })

  it('does not write a restore lookup into a session that logged out meanwhile', async () => {
    let finish: (username: string | null) => void = () => undefined
    const { controller, storedUser } = setup(() => new Promise((resolve) => {
      finish = resolve
    }), 'forged')

    await controller.restoreSession()
    await controller.logout()
    finish('real.dash')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(controller.getState().user).toBeNull()
    expect(storedUser()).toBeUndefined()
  })

  it('refreshUsername clears, replaces, or keeps the stored username', async () => {
    const answers: Array<() => Promise<string | null>> = [
      async () => 'real.dash',
      async () => null,
      async () => {
        throw new Error('offline')
      },
    ]
    const { controller, usernames } = setup(async () => 'forged')
    await controller.restoreSession()
    await vi.waitFor(() => expect(controller.getState().user?.username).toBe('forged'))
    vi.mocked(usernames.resolveUsername).mockImplementation(() => answers.shift()!())

    await controller.refreshUsername()
    expect(controller.getState().user?.username).toBe('real.dash')

    await controller.refreshUsername()
    expect(controller.getState().user?.username).toBeUndefined()

    await controller.setUsername('kept.dash')
    await expect(controller.refreshUsername()).rejects.toThrow('offline')
    expect(controller.getState().user?.username).toBe('kept.dash')
    expect(usernames.clearCache).toHaveBeenCalledWith(undefined, IDENTITY_ID)
  })

  it('does not send a user to username registration when the login lookup fails', async () => {
    let attempts = 0
    const { controller } = setup(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return 'alice.dash'
    })

    const result = await controller.loginWithAuthKey(IDENTITY_ID, 'private-key')

    expect(result.intent.kind).toBe('ready')
    await vi.waitFor(() => expect(controller.getState().user?.username).toBe('alice.dash'))
  })

  it('runs beforeStore and afterStore around the key store, and neither for a superseded sign-in', async () => {
    const { controller, storePrivateKey } = setup(async () => 'alice.dash')
    const order: string[] = []
    storePrivateKey.mockImplementation(async () => { order.push('store') })
    await controller.loginWithAuthKey(IDENTITY_ID, 'private-key', { beforeStore: () => order.push('before'), afterStore: () => order.push('after') })
    expect(order).toEqual(['before', 'store', 'after'])

    // A store that fails runs beforeStore but never afterStore.
    order.length = 0
    storePrivateKey.mockImplementation(async () => { throw new Error('storage full') })
    await expect(controller.loginWithAuthKey(IDENTITY_ID, 'private-key', { beforeStore: () => order.push('before'), afterStore: () => order.push('after') }))
      .rejects.toThrow('storage full')
    expect(order).toEqual(['before'])
    storePrivateKey.mockImplementation(async () => undefined)

    let superseded = 0
    const stale = controller.sessionEpoch()
    await controller.loginWithAuthKey(IDENTITY_ID, 'private-key')
    await expect(controller.loginWithAuthKey(IDENTITY_ID, 'private-key', { since: stale, beforeStore: () => { superseded += 1 } }))
      .rejects.toBeInstanceOf(SupersededSignInError)
    expect(superseded).toBe(0)
  })

  it('still sends a user with no username to registration on login', async () => {
    const { controller } = setup(async () => null)

    const result = await controller.loginWithAuthKey(IDENTITY_ID, 'private-key')

    expect(result.intent.kind).toBe('username-required')
  })
})

describe('PlatformAuthController key-ring login', () => {
  it('signs in without storing a private key', async () => {
    const { controller, storedUser, storePrivateKey } = setup(async () => 'alice.dash')

    const result = await controller.loginWithKeyRing('ring-identity')

    expect(result.intent).toEqual({ kind: 'ready', identityId: 'ring-identity' })
    expect(controller.getState().user?.identityId).toBe('ring-identity')
    expect(storedUser()?.identityId).toBe('ring-identity')
    expect(storePrivateKey).not.toHaveBeenCalled()
  })

  it('refuses an empty identity', async () => {
    const { controller } = setup(async () => null)
    await expect(controller.loginWithKeyRing('')).rejects.toThrow('Identity ID is required')
  })

  it('stores nothing when its keys stopped being current while it read the identity', async () => {
    let current = true
    // The username lookup is the last read before the session is stored: another sign-in lands meanwhile.
    const { controller, events, storedUser } = setup(async () => {
      current = false
      return 'alice.dash'
    }, 'raw-key.dash')
    await controller.restoreSession()
    await vi.waitFor(() => expect(storedUser()?.username).toBe('alice.dash'))
    current = true
    const before = storedUser()

    await expect(controller.loginWithKeyRing('ring-identity', { stillCurrent: () => current }))
      .rejects.toBeInstanceOf(SupersededSignInError)

    expect(storedUser()).toBe(before)
    expect(controller.getState().user?.identityId).toBe(IDENTITY_ID)
    expect(controller.getState().error).toBeNull()
    expect(events.some((event) => event.type === 'login-succeeded')).toBe(false)
  })

  it('stores nothing when another sign-in stored its session while it read the identity', async () => {
    let wallet: Promise<unknown> | null = null
    let finishWalletLookup: (username: string | null) => void = () => undefined
    const { controller, storedUser } = setup((identityId) => identityId === 'wallet-identity'
      ? new Promise((resolve) => { finishWalletLookup = resolve })
      : Promise.resolve('raw.dash'))

    wallet = controller.loginWithKeyRing('wallet-identity', { stillCurrent: () => true })
    // A typed-key sign-in for another identity completes while the wallet sign-in waits on its lookup.
    await controller.loginWithAuthKey('raw-identity', 'private-key')
    finishWalletLookup('wallet.dash')

    await expect(wallet).rejects.toBeInstanceOf(SupersededSignInError)
    expect(storedUser()?.identityId).toBe('raw-identity')
    expect(controller.getState().user?.identityId).toBe('raw-identity')
  })

  it('stores nothing when another sign-in completed before it even started reading (its keys were still being stored)', async () => {
    const { controller, storedUser } = setup(async () => 'some.dash')
    const since = controller.sessionEpoch()
    await controller.loginWithAuthKey('raw-identity', 'private-key')

    await expect(controller.loginWithKeyRing('wallet-identity', { since, stillCurrent: () => true }))
      .rejects.toBeInstanceOf(SupersededSignInError)
    expect(storedUser()?.identityId).toBe('raw-identity')
  })

  it('stores nothing for a key sign-in whose check began before another sign-in completed', async () => {
    const { controller, storedUser } = setup(async () => 'some.dash')
    // Taken before the app's key check; a wallet sign-in for another identity lands during it.
    const since = controller.sessionEpoch()
    await controller.loginWithKeyRing('wallet-identity')

    await expect(controller.loginWithAuthKey('raw-identity', 'private-key', { since })).rejects.toBeInstanceOf(SupersededSignInError)
    expect(storedUser()?.identityId).toBe('wallet-identity')
  })

  it('stores nothing when the tab signed out while it read the identity', async () => {
    let finish: (username: string | null) => void = () => undefined
    const { controller, storedUser } = setup(() => new Promise((resolve) => { finish = resolve }))
    const before = controller.sessionEpoch()

    const login = controller.loginWithAuthKey('raw-identity', 'private-key')
    await controller.logout()
    expect(controller.sessionEpoch()).not.toBe(before)
    finish('raw.dash')

    await expect(login).rejects.toBeInstanceOf(SupersededSignInError)
    expect(storedUser()).toBeUndefined()
    expect(controller.getState().user).toBeNull()
  })

  it('lets a logout called while a sign-in stores its key end that session, not be undone by it', async () => {
    let releaseKey: () => void = () => undefined
    const { controller, storedUser, storePrivateKey } = setup(async () => 'raw.dash')
    storePrivateKey.mockImplementation(() => new Promise<undefined>((resolve) => { releaseKey = () => resolve(undefined) }))

    const login = controller.loginWithAuthKey('raw-identity', 'private-key')
    await vi.waitFor(() => expect(storePrivateKey).toHaveBeenCalled())
    const logout = controller.logout()
    releaseKey()
    await login
    await logout

    expect(controller.getState().user).toBeNull()
    expect(storedUser()).toBeUndefined()
  })

  it('signs in when its keys are still current', async () => {
    const stillCurrent = vi.fn(() => true)
    const { controller, storedUser } = setup(async () => 'alice.dash')

    await controller.loginWithKeyRing('ring-identity', { stillCurrent })

    expect(stillCurrent).toHaveBeenCalledTimes(1)
    expect(storedUser()?.identityId).toBe('ring-identity')
  })
})

describe('tab-only sign-in keys', () => {
  it('a keyless tab cannot delete the session metadata used by the original tab', async () => {
    let snapshot: AuthSessionSnapshot | null = {
      user: { identityId: IDENTITY_ID, balance: 1, publicKeys: [] }, timestamp: 0,
    }
    const sessionStore = {
      getSession: () => snapshot,
      setSession: (value: AuthSessionSnapshot) => { snapshot = value },
      clearSession: () => { snapshot = null },
    }
    const tab = (hasKey: boolean) => new PlatformAuthController({
      network: 'testnet', sessionStore,
      secretStore: { hasPrivateKey: () => hasKey } as unknown as SecretStore,
      identity: { getIdentity: async () => null, getBalance: async () => 1 },
      features: { balanceRefresh: false, postLoginTasks: false },
    })
    expect(await tab(true).restoreSession()).toMatchObject({ identityId: IDENTITY_ID })
    expect(await tab(false).restoreSession()).toBeNull()
    expect(snapshot).not.toBeNull()
    expect(await tab(true).restoreSession()).toMatchObject({ identityId: IDENTITY_ID })
  })
})

describe('remote sign-out', () => {
  it('clears this controller without deleting shared session metadata or keys', async () => {
    const { controller, storedUser, clearPrivateKey, clearTabSecrets } = setup(async () => 'alice.dash')
    await controller.restoreSession()
    const epoch = controller.sessionEpoch()
    expect(await controller.logoutLocally()).toBe(true)
    expect(controller.getState().user).toBeNull()
    expect(controller.sessionEpoch()).toBeGreaterThan(epoch)
    expect(storedUser()?.identityId).toBe(IDENTITY_ID)
    expect(clearPrivateKey).not.toHaveBeenCalled()
    expect(clearTabSecrets).toHaveBeenCalledWith(IDENTITY_ID)
  })
  it('does not sign out a newer session or report that it did', async () => {
    const { controller, clearTabSecrets } = setup(async () => 'alice.dash')
    await controller.restoreSession()
    const previous = controller.sessionEpoch()
    await controller.loginWithKeyRing('new-user')
    expect(await controller.logoutLocally(previous)).toBe(false)
    expect(controller.getState().user?.identityId).toBe('new-user')
    expect(clearTabSecrets).not.toHaveBeenCalled()
  })
})
