import { describe, expect, it } from 'vitest'
import { PlatformAuthController, SupersededSignInError, type AppConnectGrant, type AppConnectSession, type SecretStore } from 'platform-auth'
import { createWalletSignIn, type WalletSignInSessions } from './wallet-sign-in'

/** A real controller over in-memory stores, so session epochs behave as in the app. */
function controller() {
  return new PlatformAuthController({
    network: 'testnet',
    sessionStore: { getSession: () => null, setSession: () => undefined, clearSession: () => undefined },
    secretStore: {
      storePrivateKey: async () => undefined,
      clearPrivateKey: async () => undefined,
      clearEncryptionKey: async () => undefined,
      clearEncryptionKeyType: async () => undefined,
      clearTransferKey: async () => undefined,
      clearLoginKey: async () => undefined,
    } as unknown as SecretStore,
    identity: { getIdentity: async (id) => ({ id, balance: 0, publicKeys: [] }), getBalance: async () => 0 },
    features: { balanceRefresh: false, postLoginTasks: false, autoDeriveEncryptionKey: false, usernameGate: false, profileGate: false },
  })
}

const grant = (identityId: string): AppConnectGrant => ({ identityId, authKeys: [], encryptionKeys: [] })
const sessionOf = (g: AppConnectGrant): AppConnectSession => ({
  v: 1, network: 'testnet', identityId: g.identityId, appId: 'app', groupId: 'group', connectionId: '00', grantedAt: 0, authKeys: [], encKeys: [],
} as unknown as AppConnectSession)

/** The key ring's one slot per network, with adoptions the test can hold back. */
function ring() {
  let slot: AppConnectSession | null = null
  const adopted: string[] = []
  const held = new Map<string, () => void>()
  const sessions: WalletSignInSessions = {
    async adopt(g) {
      adopted.push(g.identityId)
      if (held.has(g.identityId)) await new Promise<void>((resolve) => held.set(g.identityId, resolve))
      slot = sessionOf(g)
      return slot
    },
    async discard(session) {
      if (slot === session) slot = null
    },
    current: (identityId) => (slot?.identityId === identityId ? slot : null),
  }
  return {
    sessions,
    adopted,
    slot: () => slot?.identityId ?? null,
    hold: (identityId: string) => held.set(identityId, () => undefined),
    release: (identityId: string) => held.get(identityId)?.(),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createWalletSignIn', () => {
  it('signs in, then renews the same identity', async () => {
    const auth = controller()
    const keyRing = ring()
    const wallet = createWalletSignIn({ controller: auth, sessions: keyRing.sessions, settled: async () => undefined })

    await wallet.signIn(grant('alice'))
    await wallet.renew(grant('alice'))

    expect(auth.getState().user?.identityId).toBe('alice')
    expect(keyRing.adopted).toEqual(['alice', 'alice'])
    expect(keyRing.slot()).toBe('alice')
  })

  it('a sign-in that began earlier (a passkey, before its picker) is superseded by a session that won meanwhile', async () => {
    const auth = controller()
    const keyRing = ring()
    let settle = () => undefined as void
    const wallet = createWalletSignIn({ controller: auth, sessions: keyRing.sessions, settled: () => new Promise<void>((resolve) => { settle = resolve }) })
    const began = auth.sessionEpoch()
    const passkey = wallet.signIn(grant('alice'), began)
    // Another sign-in commits while this one waits for a sign-out to settle.
    await auth.loginWithKeyRing('bob')
    settle()
    await expect(passkey).rejects.toBeInstanceOf(SupersededSignInError)
    expect(auth.getState().user?.identityId).toBe('bob')
    expect(keyRing.adopted).toEqual([])
  })

  it('never installs a queued wallet sign-in over a typed-key session that completed while it waited (#734)', async () => {
    const auth = controller()
    const keyRing = ring()
    const wallet = createWalletSignIn({ controller: auth, sessions: keyRing.sessions, settled: async () => undefined })
    keyRing.hold('alice')

    const first = wallet.signIn(grant('alice'))
    const queued = wallet.signIn(grant('bob'))
    await tick()
    await auth.loginWithAuthKey('carol', 'typed-key')
    keyRing.release('alice')

    await expect(first).rejects.toBeInstanceOf(SupersededSignInError)
    await expect(queued).rejects.toBeInstanceOf(SupersededSignInError)
    expect(keyRing.adopted).toEqual(['alice'])
    expect(keyRing.slot()).toBeNull()
    expect(auth.getState().user?.identityId).toBe('carol')
  })

  it('never lets a renewal queued behind another identity\'s sign-in replace the winner\'s key ring', async () => {
    const auth = controller()
    const keyRing = ring()
    const wallet = createWalletSignIn({ controller: auth, sessions: keyRing.sessions, settled: async () => undefined })
    await wallet.signIn(grant('alice'))
    keyRing.hold('bob')

    const bob = wallet.signIn(grant('bob'))
    const renewal = wallet.renew(grant('alice'))
    await tick()
    keyRing.release('bob')

    await bob
    await expect(renewal).rejects.toBeInstanceOf(SupersededSignInError)
    expect(keyRing.adopted).toEqual(['alice', 'bob'])
    expect(keyRing.slot()).toBe('bob')
    expect(auth.getState().user?.identityId).toBe('bob')
  })

  it('refuses a renewal from another account outright', async () => {
    const auth = controller()
    const keyRing = ring()
    const wallet = createWalletSignIn({ controller: auth, sessions: keyRing.sessions, settled: async () => undefined })
    await wallet.signIn(grant('alice'))

    await expect(wallet.renew(grant('mallory'))).rejects.toThrow('The renewal came from another account')
    expect(keyRing.adopted).toEqual(['alice'])
  })
})
