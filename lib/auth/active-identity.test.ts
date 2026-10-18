import { afterEach, expect, it, vi } from 'vitest'
import { bindCurrentIdentity, currentIdentityId } from './active-identity'
import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import { SESSION_STORAGE_KEY } from '@/lib/storage-scope'

vi.mock('@/lib/upload/providers/pinata/credential-storage', () => ({ getPinataGateway: (id: string) => `${id}.mypinata.cloud` }))
let unbind: (() => void) | undefined
afterEach(() => { unbind?.(); vi.unstubAllGlobals() })

it('uses neither an unrestored shared identity nor its dedicated gateway while signed out', () => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === SESSION_STORAGE_KEY ? JSON.stringify({ user: { identityId: 'previous-user' } }) : null })
  let identity: string | null = null
  unbind = bindCurrentIdentity(() => identity)
  expect(getCurrentUserId()).toBeNull()
  expect(getAllGatewayUrls('ipfs://QmExample')).not.toContain('https://previous-user.mypinata.cloud/ipfs/QmExample')
  identity = 'restored-user'
  expect(getCurrentUserId()).toBe('restored-user')
  expect(getAllGatewayUrls('ipfs://QmExample')[0]).toBe('https://restored-user.mypinata.cloud/ipfs/QmExample')
  identity = null
  expect(getCurrentUserId()).toBeNull()
  expect(getAllGatewayUrls('ipfs://QmExample')[0]).not.toContain('mypinata.cloud')
})

it('unbinding an old provider does not detach the newer controller', () => {
  const old = bindCurrentIdentity(() => 'old')
  unbind = bindCurrentIdentity(() => 'new')
  old()
  expect(currentIdentityId()).toBe('new')
  unbind()
  expect(currentIdentityId()).toBeNull()
})
