import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('order status privacy disclosure', () => {
  it.each(['v1', 'v9', 'v10'])('describes what the configured %s contract actually publishes', async (topology) => {
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology)
    vi.resetModules()
    const { orderStatusPrivacyDisclosure } = await import('./legal')
    const copy = orderStatusPrivacyDisclosure()
    if (topology === 'v10') {
      expect(copy).toContain('encrypted for you and the seller')
      expect(copy).not.toContain('are public')
    } else {
      expect(copy).toContain('are public. Do not include private information')
      expect(copy).not.toContain('encrypted')
    }
  })
})
