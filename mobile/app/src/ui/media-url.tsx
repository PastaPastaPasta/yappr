import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { imageSourceFor, isDeniedMedia } from '~/lib-allowlist';

/** How large the proxy serves a non-IPFS image (lib/media/remote-media `ProxyImageSize`). */
type ImageSize = 'avatar' | 'thumbnail' | 'full';

/**
 * Turns stored media and link URLs into ones the app may load or open.
 * `ipfs://` goes through an HTTP gateway; only http(s) leaves the app.
 *
 * TODO(S0): wire the provider to `engine.info().ipfsGateways`, with
 * fallback to the next gateway (UX_SPEC 2.4.6). Until then: ipfs.io.
 */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const IPFS = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i;
const HTTP = /^https?:\/\/[^\s/?#]+/i;

const DATA_IMAGE = /^data:image\//i;

/** An http(s) URL for an `ipfs://` or http(s) one; null for any other scheme. */
function toHttp(url: string | null | undefined, gateway: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const ipfs = IPFS.exec(trimmed);
  if (ipfs) return `${gateway}${ipfs[1]}`;
  return HTTP.test(trimmed) ? trimmed : null;
}

/**
 * An image source the app may load, by the web's rule (lib/media/remote-media):
 * IPFS via the gateway, any other https image via the wsrv.nl image proxy (so
 * the host never sees the viewer's IP), an inline `data:image/` as it is.
 * Null for media on the takedown denylist, plain http and every other scheme.
 */
export function resolveMediaUrl(
  url: string | null | undefined,
  gateway = DEFAULT_IPFS_GATEWAY,
  size: ImageSize = 'full',
): string | null {
  const source = imageSourceFor(url, size);
  switch (source.kind) {
    case 'ipfs':
      return `${gateway}${source.ipfsUrl.slice('ipfs://'.length)}`;
    case 'proxied':
      return source.url;
    case 'local':
      // Only inline images: no `blob:` or app-relative paths on native.
      return DATA_IMAGE.test(source.url) ? source.url : null;
    default:
      return null;
  }
}

/**
 * The guard every external link goes through before it reaches Linking or
 * the in-app browser: http(s) only, IPFS via the gateway, anything else
 * (`javascript:`, `file:`, app schemes) and anything on the takedown
 * denylist refused.
 */
export function safeExternalUrl(
  url: string | null | undefined,
  gateway = DEFAULT_IPFS_GATEWAY,
): string | null {
  if (url && isDeniedMedia(url)) return null;
  return toHttp(url, gateway);
}

const GatewayContext = createContext(DEFAULT_IPFS_GATEWAY);

export function MediaUrlProvider({ ipfsGateway, children }: { ipfsGateway: string; children: ReactNode }) {
  return <GatewayContext.Provider value={ipfsGateway}>{children}</GatewayContext.Provider>;
}

/** `media` for image sources, `external` for links: both bound to the provider's gateway. */
export function useMediaUrls() {
  const gateway = useContext(GatewayContext);
  return useMemo(
    () => ({
      media: (url: string | null | undefined, size?: ImageSize) => resolveMediaUrl(url, gateway, size) ?? undefined,
      external: (url: string | null | undefined) => safeExternalUrl(url, gateway),
    }),
    [gateway],
  );
}
