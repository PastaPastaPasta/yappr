import { useEffect, useState } from 'react'
import { PlatformAuthController, type AuthSessionSnapshot, type SecretStore } from 'platform-auth'
import { observeSignOut } from '@/lib/auth/cross-tab-sign-out'
import { SESSION_STORAGE_KEY, scopedKey } from '@/lib/storage-scope'

const tabKey = scopedKey('qa-tab-only-key-present')
const snapshot: AuthSessionSnapshot = { user: { identityId: 'offline', balance: 1, publicKeys: [] }, timestamp: 0 }
const controller = new PlatformAuthController({
  network: 'testnet',
  sessionStore: {
    getSession: () => JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null') as AuthSessionSnapshot | null,
    setSession: (value) => localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value)),
    clearSession: () => localStorage.removeItem(SESSION_STORAGE_KEY),
  },
  secretStore: {
    hasPrivateKey: () => sessionStorage.getItem(tabKey) === 'present',
    clearPrivateKey: () => sessionStorage.removeItem(tabKey),
    clearTabSecrets: () => sessionStorage.removeItem(tabKey),
    clearEncryptionKey: () => undefined,
    clearEncryptionKeyType: () => undefined,
    clearTransferKey: () => undefined,
    clearLoginKey: () => undefined,
  } as unknown as SecretStore,
  identity: { getIdentity: async () => null, getBalance: async () => 1 },
  features: { balanceRefresh: false, postLoginTasks: false },
})

/** Real auth controller and storage observer, with an offline key-presence port. No secrets or network. */
export function SessionFixture() {
  const [user, setUser] = useState(controller.getState().user)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(false)
  useEffect(() => {
    const unsubscribe = controller.subscribe((state) => { setUser(state.user); if (!state.user) setDialog(false) })
    const restore = () => controller.restoreSession().catch(() => setError('Restore failed'))
    restore()
    const stop = observeSignOut(() => { controller.logoutLocally().catch(() => setError('Logout failed')) })
    return () => { unsubscribe(); stop(); controller.dispose() }
  }, [])
  return <section><h2>{user ? 'Signed in' : 'Signed out'}</h2>
    <button onClick={() => {
      sessionStorage.setItem(tabKey, 'present')
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot))
      controller.restoreSession().catch(() => setError('Restore failed'))
    }}>Restore fixture session</button>
    <button onClick={() => controller.logout().catch(() => setError('Logout failed'))}>Sign out</button>
    {user && <button onClick={() => setDialog(true)}>Account controls</button>}
    {dialog && <div role="dialog" aria-label="Account settings">Manage account</div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
