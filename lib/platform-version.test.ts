import { describe, expect, it } from 'vitest'
import { PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk'
import { networkPlatformVersion } from './platform-version.mjs'

describe('networkPlatformVersion', () => {
  it('builds under the connected network version, not the newest the SDK knows', async () => {
    await ensureInitialized()
    expect(PlatformVersion.latest().version).toBeGreaterThan(14)
    expect(networkPlatformVersion(PlatformVersion, { version: () => 14 }).version).toBe(14)
    expect(networkPlatformVersion(PlatformVersion, { version: () => 15 }).version).toBe(15)
  })
})
