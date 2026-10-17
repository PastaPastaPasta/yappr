/**
 * The Content-Security-Policy sources images and video may load from
 * (app/layout.tsx): the image proxy and the IPFS gateways, never an
 * arbitrary host (lib/media/remote-media). A test holds the gateway list in
 * step with lib/utils/ipfs-gateway's IPFS_GATEWAYS.
 */

import { IMAGE_PROXY_ORIGIN } from './remote-media'

export const IPFS_GATEWAY_CSP_SOURCES = [
  'https://gateway.pinata.cloud',
  'https://ipfs.4everland.io',
  'https://ipfs.io',
  'https://*.ipfs.dweb.link',
  // A signed-in user's own dedicated Pinata gateway (ipfs-gateway.ts).
  'https://*.mypinata.cloud',
]

export const IMG_SRC = ["'self'", 'data:', 'blob:', IMAGE_PROXY_ORIGIN, ...IPFS_GATEWAY_CSP_SOURCES].join(' ')
export const MEDIA_SRC = ["'self'", 'blob:', ...IPFS_GATEWAY_CSP_SOURCES].join(' ')
