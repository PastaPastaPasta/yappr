import { createContext, useContext, useMemo, type ReactNode } from 'react';

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

/** An image source the app may load: http(s), IPFS via the gateway, or an inline `data:image/`. */
export function resolveMediaUrl(
  url: string | null | undefined,
  gateway = DEFAULT_IPFS_GATEWAY,
): string | null {
  if (url && DATA_IMAGE.test(url)) return url;
  return toHttp(url, gateway);
}

/**
 * The guard every external link goes through before it reaches Linking or
 * the in-app browser: http(s) only, IPFS via the gateway, anything else
 * (`javascript:`, `file:`, app schemes) refused.
 */
export function safeExternalUrl(
  url: string | null | undefined,
  gateway = DEFAULT_IPFS_GATEWAY,
): string | null {
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
      media: (url: string | null | undefined) => resolveMediaUrl(url, gateway) ?? undefined,
      external: (url: string | null | undefined) => safeExternalUrl(url, gateway),
    }),
    [gateway],
  );
}
