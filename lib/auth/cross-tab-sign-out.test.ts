import { afterEach, expect, it, vi } from 'vitest'
import { observeSignOut } from './cross-tab-sign-out'
import { SESSION_STORAGE_KEY } from '@/lib/storage-scope'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); vi.unstubAllGlobals() })

it('observes only removals of this deployment, ignores stale events after sign-in, and unsubscribes', () => {
  const target = new EventTarget()
  const storage = { getItem: vi.fn((): string | null => null) }
  vi.stubGlobal('window', target)
  vi.stubGlobal('localStorage', storage)
  const signedOut = vi.fn()
  cleanup = observeSignOut(signedOut)
  const change = (key: string | null, storageArea = storage) => {
    target.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }))
  }
  change('another-deployment:yappr_session')
  change(SESSION_STORAGE_KEY, { ...storage })
  expect(signedOut).not.toHaveBeenCalled()
  change(SESSION_STORAGE_KEY)
  expect(signedOut).toHaveBeenCalledTimes(1)
  storage.getItem.mockReturnValue('new-session')
  change(SESSION_STORAGE_KEY)
  expect(signedOut).toHaveBeenCalledTimes(1)
  storage.getItem.mockReturnValue(null)
  change(null)
  expect(signedOut).toHaveBeenCalledTimes(2)
  cleanup()
  change(SESSION_STORAGE_KEY)
  expect(signedOut).toHaveBeenCalledTimes(2)
})
