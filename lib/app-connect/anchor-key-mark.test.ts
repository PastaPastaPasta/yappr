import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubBrowserStorage } from '@/lib/test-storage'

async function load() {
  vi.resetModules()
  return import('./anchor-key-mark')
}

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anchor key mark', () => {
  it('tells listeners about every confirmation, so a waiting DM engine can start (also after a new sign-in)', async () => {
    const { onAnchorKeyRemembered, rememberAnchorKey, rememberedAnchorKey } = await load()
    const heard: string[] = []
    const stop = onAnchorKeyRemembered((identityId) => heard.push(identityId))
    rememberAnchorKey('alice', Uint8Array.of(1, 2))
    rememberAnchorKey('alice', Uint8Array.of(1, 2))
    rememberAnchorKey('alice', Uint8Array.of(3))
    expect(heard).toEqual(['alice', 'alice', 'alice'])
    expect(rememberedAnchorKey('alice')).toBe('03')
    stop()
    rememberAnchorKey('bob', Uint8Array.of(4))
    expect(heard).toEqual(['alice', 'alice', 'alice'])
  })
})
