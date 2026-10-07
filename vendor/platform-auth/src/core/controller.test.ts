import { describe, expect, it, vi } from 'vitest'
import { PlatformAuthController } from './controller'
import type { AuthSessionSnapshot, AuthUser, PlatformAuthEvent, SecretStore, UsernamePort } from './types'

const IDENTITY_ID = 'victim-identity'

function setup(resolveUsername: UsernamePort['resolveUsername'], storedUsername?: string) {
  let session: AuthSessionSnapshot | null = {
    user: { identityId: IDENTITY_ID, balance: 1, username: storedUsername, publicKeys: [] },
    timestamp: 0,
  }
  const events: PlatformAuthEvent[] = []
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
      storePrivateKey: async () => undefined,
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

  it('does not overwrite a username set while the restore lookup was in flight', async () => {
    let finish: (username: string | null) => void = () => undefined
    const { controller, storedUser } = setup(() => new Promise((resolve) => {
      finish = resolve
    }))

    await controller.restoreSession()
    await controller.setUsername('fresh.dash')
    finish(null)

    await vi.waitFor(() => expect(controller.getState().user?.username).toBe('fresh.dash'))
    expect(storedUser()?.username).toBe('fresh.dash')
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

  it('still sends a user with no username to registration on login', async () => {
    const { controller } = setup(async () => null)

    const result = await controller.loginWithAuthKey(IDENTITY_ID, 'private-key')

    expect(result.intent.kind).toBe('username-required')
  })
})
