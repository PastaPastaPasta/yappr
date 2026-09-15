/**
 * Fetching a page for its preview metadata. `ipfs://` goes through the
 * gateway list, a short allow-list of CORS-enabled hosts is fetched directly,
 * and everything else goes through a third-party CORS proxy.
 */

import { IPFS_GATEWAYS, isIpfsProtocol, isIpfsUrl, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'

/**
 * PRIVACY: the proxies see every URL they fetch. Rich previews are on by
 * default; the settings page and the preview modal disclose this using the
 * lists below. Keep them in step with CORS_PROXIES and CORS_ALLOWED_DOMAINS.
 */
export const CORS_PROXY_INFO = {
  warning:
    'Some URLs (YouTube, Reddit, IPFS, etc.) are fetched directly from their services. Other URLs use third-party proxy servers to fetch metadata. These services may log the URLs you view.',
  directServices: [
    { name: 'YouTube', description: 'Video thumbnails (img.youtube.com)' },
    { name: 'Reddit', description: 'Image hosting (i.redd.it)' },
    { name: 'Imgur', description: 'Image hosting (i.imgur.com)' },
    { name: 'Giphy', description: 'GIF hosting (media.giphy.com)' },
    { name: 'GitHub', description: 'Raw files (raw.githubusercontent.com)' },
    { name: 'Twitter/X', description: 'Images (pbs.twimg.com)' },
  ],
  /** IPFS gateways used for ipfs:// URLs (derived from the shared gateway list) */
  ipfsGateways: IPFS_GATEWAYS.map((gateway) => ({ name: gateway.domain, url: `https://${gateway.domain}` })),
  proxies: [
    { name: 'allorigins.win', url: 'https://allorigins.win/' },
    { name: 'corsproxy.io', url: 'https://corsproxy.io/' },
  ],
}

const CORS_PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
]

/** Major hosts known to send CORS headers; fetched without a proxy. Keep it short to limit IP exposure. */
const CORS_ALLOWED_DOMAINS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'i.imgur.com',
  'i.redd.it',
  'pbs.twimg.com',
  'raw.githubusercontent.com',
])

const FETCH_TIMEOUT_MS = 8000
/** Larger bodies are not worth downloading for a title and an image URL. */
const MAX_PREVIEW_SIZE_BYTES = 5 * 1024 * 1024

export interface PreviewFetchResult {
  content: string
  contentType: string | null
  /** For ipfs:// URLs, the gateway URL that actually answered, which a browser can load. */
  resolvedUrl?: string
}

export function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false
  return contentType.split(';')[0].trim().toLowerCase().startsWith('image/')
}

function isCorsAllowedDomain(url: string): boolean {
  try {
    return CORS_ALLOWED_DOMAINS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response
  } finally {
    clearTimeout(timeout)
  }
}

/** Fetch without a proxy. Images are not downloaded; only their Content-Type matters. */
async function fetchDirectly(url: string): Promise<PreviewFetchResult> {
  const response = await fetchWithTimeout(url)
  const contentType = response.headers.get('content-type')
  if (isImageContentType(contentType)) return { content: '', contentType }
  const size = parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(size) && size > MAX_PREVIEW_SIZE_BYTES) throw new Error('Content too large for preview')
  return { content: await response.text(), contentType }
}

/** Try each candidate in order; the first success wins, the last failure is thrown. */
async function firstSuccessful(
  candidates: string[],
  attempt: (url: string) => Promise<PreviewFetchResult>
): Promise<PreviewFetchResult> {
  let lastError: unknown = new Error('No candidates')
  for (const candidate of candidates) {
    try {
      return await attempt(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function fetchPreviewContent(url: string): Promise<PreviewFetchResult> {
  if (isIpfsProtocol(url)) {
    return firstSuccessful(getAllGatewayUrls(url), async (gatewayUrl) => ({
      ...(await fetchDirectly(gatewayUrl)),
      resolvedUrl: gatewayUrl,
    }))
  }
  if (isIpfsUrl(url)) return fetchDirectly(url)
  if (isCorsAllowedDomain(url)) {
    try {
      return await fetchDirectly(url)
    } catch {
      // A direct fetch that fails still has the proxies to fall back on.
    }
  }
  // Proxies do not preserve Content-Type reliably, so the body is treated as HTML.
  return firstSuccessful(
    CORS_PROXIES.map((proxy) => proxy(url)),
    async (proxyUrl) => ({ content: await (await fetchWithTimeout(proxyUrl)).text(), contentType: 'text/html' })
  )
}
