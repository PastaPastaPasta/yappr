import { describe, expect, it } from 'vitest'
import { IPFS_GATEWAYS, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import { IMG_SRC, IPFS_GATEWAY_CSP_SOURCES, MEDIA_SRC } from './media-csp'
import { proxiedImageUrl } from './remote-media'

/** Whether a CSP host source (with an optional leading `*.`) allows a URL's origin. */
function allows(source: string, url: string): boolean {
  const { protocol, hostname } = new URL(url)
  const match = /^(https:)\/\/(\*\.)?(.+)$/.exec(source)
  if (!match || match[1] !== protocol) return false
  return match[2] ? hostname.endsWith(`.${match[3]}`) : hostname === match[3]
}

describe('the image and media CSP', () => {
  it('allows every IPFS gateway the app loads from', () => {
    expect(IPFS_GATEWAYS.length).toBeGreaterThan(0)
    for (const url of getAllGatewayUrls('ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/a.png')) {
      expect(IPFS_GATEWAY_CSP_SOURCES.some((source) => allows(source, url))).toBe(true)
    }
  })

  it('allows the image proxy for images only, and no other host', () => {
    expect(IMG_SRC.split(' ').some((source) => allows(source, proxiedImageUrl('https://x.example/a.jpg')))).toBe(true)
    expect(MEDIA_SRC).not.toContain('wsrv.nl')
    for (const directive of [IMG_SRC, MEDIA_SRC]) {
      expect(directive.split(' ')).not.toContain('https:')
      expect(directive.split(' ').some((source) => allows(source, 'https://tracker.example/pixel.png'))).toBe(false)
    }
  })
})
