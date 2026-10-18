/**
 * Fetching a page for its preview metadata, from the viewer's browser. Only
 * two kinds of link are fetched: `ipfs://` (and IPFS gateway URLs) through the
 * gateway list, and a short allow-list of CORS-enabled hosts. Every other link
 * is shown as a card built from the URL alone (see ./preview): nothing is
 * fetched and no preview service sees it.
 */

import { IPFS_GATEWAYS, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import { IMAGE_PROXY_ORIGIN, imageSourceFor, isSafeMediaUrl } from '@/lib/media/remote-media'

/** Major hosts known to send CORS headers; fetched directly. Keep it short to limit IP exposure. */
const CORS_ALLOWED_DOMAINS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'i.imgur.com',
  'i.redd.it',
  'pbs.twimg.com',
  'raw.githubusercontent.com',
])

/**
 * PRIVACY: who sees what when previews are on. The settings page and the
 * preview modal show these lists; keep them in step with
 * CORS_ALLOWED_DOMAINS, the gateway list and lib/media/remote-media.
 */
export const LINK_PREVIEW_SERVICES = {
  summary:
    'Most previews are made from the link itself, without contacting the website. Links to IPFS and a few image hosts are read directly from those services. Pictures that aren\'t on IPFS load through the wsrv.nl image service, so the sites hosting them don\'t see your IP address.',
  directServices: [
    { name: 'Reddit', description: 'Image hosting (i.redd.it)' },
    { name: 'Imgur', description: 'Image hosting (i.imgur.com)' },
    { name: 'Giphy', description: 'GIF hosting (media.giphy.com, i.giphy.com)' },
    { name: 'GitHub', description: 'Raw images (raw.githubusercontent.com)' },
    { name: 'Twitter/X', description: 'Images (pbs.twimg.com)' },
  ],
  /** IPFS gateways used for ipfs:// URLs (derived from the shared gateway list) */
  ipfsGateways: IPFS_GATEWAYS.map((gateway) => ({ name: gateway.domain, url: `https://${gateway.domain}` })),
  imageProxy: { name: 'wsrv.nl', url: `${IMAGE_PROXY_ORIGIN}/` },
}

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

/** The deadline covers headers and streamed, decoded bytes, including chunked bodies. */
async function fetchDirectly(url: string): Promise<PreviewFetchResult> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Preview request timed out'))
      controller.abort()
    }, FETCH_TIMEOUT_MS)
  })
  const read = async (): Promise<PreviewFetchResult> => {
    const response = await fetch(url, { signal: controller.signal })
    reader = response.body?.getReader()
    if (controller.signal.aborted) {
      reader?.cancel().catch(() => undefined)
      throw new Error('Preview request timed out')
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')
    if (isImageContentType(contentType)) return { content: '', contentType }
    const mime = contentType?.split(';')[0].trim().toLowerCase()
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml') throw new Error('Unsupported preview content type')
    const declaredSize = Number(response.headers.get('content-length'))
    if (declaredSize > MAX_PREVIEW_SIZE_BYTES) throw new Error('Content too large for preview')
    const decoder = new TextDecoder()
    let size = 0
    let content = ''
    if (reader) {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_PREVIEW_SIZE_BYTES) throw new Error('Content too large for preview')
        content += decoder.decode(chunk.value, { stream: true })
      }
    }
    return { content: content + decoder.decode(), contentType }
  }
  try {
    return await Promise.race([read(), expired])
  } finally {
    clearTimeout(timeout)
    controller.abort()
    // Cancel unused images, rejected types and oversized or stalled streams.
    // Do not wait for a stalled source's cancellation callback to finish.
    reader?.cancel().catch(() => undefined)
  }
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

/**
 * IPFS content (`ipfs://` or any gateway's URL) is read from Yappr's own
 * gateway list, never from the host the link names.
 */
function ipfsContentOf(url: string): string | null {
  const source = imageSourceFor(url)
  return source.kind === 'ipfs' ? source.ipfsUrl : null
}

/**
 * Whether a link's page may be fetched for its preview: only structurally safe
 * IPFS content, or an allow-listed https host.
 */
export function canFetchPreview(url: string): boolean {
  if (!isSafeMediaUrl(url)) return false
  return ipfsContentOf(url) !== null || (url.startsWith('https://') && isCorsAllowedDomain(url))
}

/** Callers check {@link canFetchPreview} first; anything else is refused. */
export async function fetchPreviewContent(url: string): Promise<PreviewFetchResult> {
  const ipfsUrl = ipfsContentOf(url)
  if (ipfsUrl) {
    return firstSuccessful(getAllGatewayUrls(ipfsUrl), async (gatewayUrl) => ({
      ...(await fetchDirectly(gatewayUrl)),
      resolvedUrl: gatewayUrl,
    }))
  }
  if (!canFetchPreview(url)) throw new Error('Not fetched for previews')
  return fetchDirectly(url)
}
