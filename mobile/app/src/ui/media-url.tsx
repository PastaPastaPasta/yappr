import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { imageSourceFor, isSafeMediaUrl } from '~/lib-allowlist';

/** How large the proxy serves a non-IPFS image (lib/media/remote-media `ProxyImageSize`). */
export type ImageSize = 'avatar' | 'thumbnail' | 'full';

/**
 * Turns stored media and link URLs into ones the app may load or open.
 * `ipfs://` goes through an HTTP gateway; only http(s) leaves the app.
 *
 * The provider carries the engine's ordered gateway list
 * (`engine.info().ipfsGateways`). Images try it in order, falling back to the
 * next gateway on an error or after 8 s (UX_SPEC 2.4.6, `useMediaSource`).
 * Until the engine reports one: ipfs.io.
 */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** One entry of the engine's gateway list (`engine.info().ipfsGateways`). */
export interface IpfsGateway {
  domain: string;
  format: 'path' | 'subdomain';
}

export const DEFAULT_IPFS_GATEWAYS: readonly IpfsGateway[] = [{ domain: 'ipfs.io', format: 'path' }];

const IPFS = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i;
const HTTP = /^https?:\/\/[^\s/?#]+/i;

const DATA_IMAGE = /^data:image\//i;

/** CIDv0 is case-sensitive base58, which a DNS label can't hold: subdomain gateways can't serve it. */
const isCidV0 = (cid: string) => cid.startsWith('Qm');

/** Where one gateway serves `cid` + `path` (`path` is empty or starts with `/`); null when it can't. */
function gatewayUrl(gateway: IpfsGateway, cid: string, path: string): string | null {
  if (gateway.format === 'subdomain') return isCidV0(cid) ? null : `https://${cid}.${gateway.domain}${path}`;
  return `https://${gateway.domain}/ipfs/${cid}${path}`;
}

/** The first path-style gateway as a base URL (`https://host/ipfs/`), for links the user opens or shares. */
function pathGatewayBase(gateways: readonly IpfsGateway[]): string {
  const gateway = gateways.find((g) => g.format === 'path');
  return gateway ? `https://${gateway.domain}/ipfs/` : DEFAULT_IPFS_GATEWAY;
}

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
 * Null for malformed URLs, plain http and every other scheme.
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
 * Every URL an image may load from, in the order to try them: an `ipfs://`
 * reference once per gateway that can serve it, any other source on its own.
 * Empty for a URL the app refuses to load.
 */
export function mediaCandidates(
  url: string | null | undefined,
  gateways: readonly IpfsGateway[] = DEFAULT_IPFS_GATEWAYS,
  size: ImageSize = 'full',
): string[] {
  const source = imageSourceFor(url, size);
  if (source.kind !== 'ipfs') {
    const single = resolveMediaUrl(url, DEFAULT_IPFS_GATEWAY, size);
    return single ? [single] : [];
  }
  const reference = source.ipfsUrl.slice('ipfs://'.length);
  const slash = reference.indexOf('/');
  const cid = slash === -1 ? reference : reference.slice(0, slash);
  const path = slash === -1 ? '' : reference.slice(slash);
  const urls = gateways.map((gateway) => gatewayUrl(gateway, cid, path)).filter((u): u is string => u !== null);
  return urls.length > 0 ? urls : [`${DEFAULT_IPFS_GATEWAY}${reference}`];
}

/**
 * The guard every external link goes through before it reaches Linking or
 * the in-app browser: http(s) only, IPFS via the gateway, anything else
 * (`javascript:`, `file:`, app schemes) and malformed URLs refused.
 */
export function safeExternalUrl(
  url: string | null | undefined,
  gateway = DEFAULT_IPFS_GATEWAY,
): string | null {
  if (url && !isSafeMediaUrl(url)) return null;
  return toHttp(url, gateway);
}

const GatewayContext = createContext<readonly IpfsGateway[]>(DEFAULT_IPFS_GATEWAYS);

export function MediaUrlProvider({
  ipfsGateways,
  children,
}: {
  ipfsGateways: readonly IpfsGateway[];
  children: ReactNode;
}) {
  return <GatewayContext.Provider value={ipfsGateways}>{children}</GatewayContext.Provider>;
}

/**
 * `media` for an image's first source, `candidates` for all of them in the
 * order to try (`useMediaSource` walks them), `external` for links: all bound
 * to the provider's gateways.
 */
export function useMediaUrls() {
  const gateways = useContext(GatewayContext);
  return useMemo(() => {
    const base = pathGatewayBase(gateways);
    return {
      media: (url: string | null | undefined, size?: ImageSize) => mediaCandidates(url, gateways, size)[0],
      candidates: (url: string | null | undefined, size?: ImageSize) => mediaCandidates(url, gateways, size),
      external: (url: string | null | undefined) => safeExternalUrl(url, base),
    };
  }, [gateways]);
}
