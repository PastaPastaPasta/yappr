'use client'

import { useState, useEffect } from 'react'
import type { LinkPreviewData } from '@/components/post/link-preview'

// Client-side cache for link previews
const previewCache = new Map<string, LinkPreviewData>()
const pendingRequests = new Map<string, Promise<LinkPreviewData>>()

/**
 * CORS Proxy Configuration
 *
 * PRIVACY WARNING: These third-party proxies will see all URLs being fetched.
 * Rich link previews are disabled by default for privacy. Users can opt-in
 * via settings, with clear disclosure about third-party data sharing.
 *
 * Proxy Privacy Policies:
 * - allorigins.win: https://allorigins.win/ (no formal policy)
 * - corsproxy.io: https://corsproxy.io/ (no formal policy)
 */
export const CORS_PROXY_INFO = {
  warning: 'Rich previews send URLs to third-party proxy servers to fetch metadata. These services may log the URLs you view.',
  proxies: [
    { name: 'allorigins.win', url: 'https://allorigins.win/' },
    { name: 'corsproxy.io', url: 'https://corsproxy.io/' },
  ],
}

const CORS_PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
]

// URLs that commonly don't have good previews or should be skipped
const SKIP_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
]

// Common image file extensions
const IMAGE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'
]

/**
 * IPFS Gateway Configuration
 * These public gateways are used to resolve ipfs:// protocol URLs.
 * Gateways are tried in order until one succeeds.
 */
const IPFS_GATEWAYS = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://cloudflare-ipfs.com',
]

/**
 * Check if a URL uses the ipfs:// protocol.
 */
export function isIpfsProtocol(url: string): boolean {
  return url.toLowerCase().startsWith('ipfs://')
}

/**
 * Extract CID from an ipfs:// URL.
 * Handles formats like:
 * - ipfs://CID
 * - ipfs://CID/path/to/file
 */
function extractCidFromIpfsUrl(url: string): { cid: string; path: string } | null {
  if (!isIpfsProtocol(url)) return null

  // Remove ipfs:// prefix
  const remainder = url.slice(7)
  if (!remainder) return null

  // Split into CID and optional path
  const slashIndex = remainder.indexOf('/')
  if (slashIndex === -1) {
    return { cid: remainder, path: '' }
  }

  return {
    cid: remainder.slice(0, slashIndex),
    path: remainder.slice(slashIndex),
  }
}

/**
 * Convert an ipfs:// URL to an HTTP gateway URL.
 */
function ipfsToGatewayUrl(ipfsUrl: string, gateway: string): string | null {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed) return null

  return `${gateway}/ipfs/${parsed.cid}${parsed.path}`
}

/**
 * Check if a URL points to IPFS content.
 * IPFS gateways typically have CORS headers enabled, so we can fetch directly.
 *
 * Matches:
 * - Protocol: ipfs:// URLs
 * - Subdomain gateways: hostname contains ".ipfs." (e.g., bafybeib.ipfs.dweb.link)
 * - Direct gateways: ipfs.io domain (e.g., gateway.ipfs.io, ipfs.io)
 * - Path gateways: path starts with /ipfs/ (e.g., https://gateway.pinata.cloud/ipfs/Qm...)
 */
export function isIpfsUrl(url: string): boolean {
  // Check for ipfs:// protocol first (before URL parsing which doesn't support it)
  if (isIpfsProtocol(url)) {
    return true
  }

  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    // Check for subdomain gateway pattern: *.ipfs.* (e.g., cid.ipfs.dweb.link)
    if (hostname.includes('.ipfs.')) {
      return true
    }

    // Check for ipfs.io domain specifically (e.g., ipfs.io, gateway.ipfs.io)
    if (hostname === 'ipfs.io' || hostname.endsWith('.ipfs.io')) {
      return true
    }

    // Check for path gateway pattern: /ipfs/ in the path
    if (pathname.startsWith('/ipfs/')) {
      return true
    }

    return false
  } catch {
    return false
  }
}

/**
 * Check if a URL points directly to an image file based on its extension.
 * This is used to render direct image links with a larger preview format.
 */
export function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext))
  } catch {
    return false
  }
}

function shouldSkipUrl(url: string): boolean {
  // Never skip ipfs:// protocol URLs
  if (isIpfsProtocol(url)) {
    return false
  }

  try {
    const parsed = new URL(url)
    return SKIP_DOMAINS.some(domain => parsed.hostname.includes(domain))
  } catch {
    return true
  }
}

// Extract meta tag content from HTML
function extractMetaContent(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) {
      // Decode HTML entities
      return match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim()
    }
  }
  return undefined
}

// Make relative URLs absolute
function makeAbsoluteUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined
  if (url.startsWith('http')) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/')) {
    try {
      const base = new URL(baseUrl)
      return `${base.origin}${url}`
    } catch {
      return url
    }
  }
  try {
    return new URL(url, baseUrl).href
  } catch {
    return url
  }
}

// Extract favicon URL
function extractFavicon(html: string, baseUrl: string): string | undefined {
  const iconPatterns = [
    /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i,
    /<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i,
  ]

  for (const pattern of iconPatterns) {
    const match = html.match(pattern)
    if (match?.[1]) {
      return makeAbsoluteUrl(match[1], baseUrl)
    }
  }

  // Default to /favicon.ico
  try {
    const url = new URL(baseUrl)
    return `${url.origin}/favicon.ico`
  } catch {
    return undefined
  }
}

function parseHtmlForPreview(html: string, url: string): LinkPreviewData {
  const title = extractMetaContent(html, [
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i,
    /<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:title["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ])

  const description = extractMetaContent(html, [
    /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i,
    /<meta[^>]*name=["']twitter:description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:description["']/i,
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i,
  ])

  const imageRaw = extractMetaContent(html, [
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
  ])

  const siteName = extractMetaContent(html, [
    /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i,
  ])

  // Extract image dimensions from OG meta tags
  const imageWidthRaw = extractMetaContent(html, [
    /<meta[^>]*property=["']og:image:width["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image:width["']/i,
  ])
  const imageHeightRaw = extractMetaContent(html, [
    /<meta[^>]*property=["']og:image:height["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image:height["']/i,
  ])

  const image = makeAbsoluteUrl(imageRaw, url)
  const favicon = extractFavicon(html, url)
  const imageWidth = imageWidthRaw ? parseInt(imageWidthRaw, 10) : undefined
  const imageHeight = imageHeightRaw ? parseInt(imageHeightRaw, 10) : undefined

  return {
    url,
    title,
    description,
    image,
    imageWidth: imageWidth && !isNaN(imageWidth) ? imageWidth : undefined,
    imageHeight: imageHeight && !isNaN(imageHeight) ? imageHeight : undefined,
    siteName,
    favicon,
  }
}

interface FetchResult {
  content: string
  contentType: string | null
}

// Maximum content size to download for preview metadata (5MB)
const MAX_PREVIEW_SIZE_BYTES = 5 * 1024 * 1024

/**
 * Check if a Content-Type header indicates an image.
 */
function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false
  // Split on semicolon to handle "image/png; charset=utf-8"
  const mimeType = contentType.split(';')[0].trim().toLowerCase()
  return mimeType.startsWith('image/')
}

/**
 * Fetch content directly without CORS proxy.
 * Used for IPFS gateways which typically have CORS headers enabled.
 * Returns both content and Content-Type header for detecting images.
 *
 * For images, skips downloading content (we only need Content-Type).
 * Rejects files larger than MAX_PREVIEW_SIZE_BYTES to prevent memory issues.
 */
async function fetchDirectly(url: string): Promise<FetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const contentType = response.headers.get('content-type')

    // For images, we only need the Content-Type - skip downloading the body
    if (isImageContentType(contentType)) {
      return { content: '', contentType }
    }

    // Check Content-Length to prevent downloading huge files
    const contentLength = response.headers.get('content-length')
    if (contentLength) {
      const size = parseInt(contentLength, 10)
      if (!isNaN(size) && size > MAX_PREVIEW_SIZE_BYTES) {
        throw new Error('Content too large for preview')
      }
    }

    const content = await response.text()
    return { content, contentType }
  } catch (err) {
    clearTimeout(timeout)
    throw err instanceof Error ? err : new Error('Unknown error')
  }
}

/**
 * Fetch HTML via CORS proxy with fallback support
 * Tries each proxy in order until one succeeds
 */
async function fetchViaProxy(url: string): Promise<string> {
  let lastError: Error | null = null

  for (const proxyFn of CORS_PROXIES) {
    const proxyUrl = proxyFn(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const response = await fetch(proxyUrl, {
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return await response.text()
    } catch (err) {
      clearTimeout(timeout)
      lastError = err instanceof Error ? err : new Error('Unknown error')
      // Continue to next proxy
    }
  }

  throw lastError || new Error('All proxies failed')
}

/**
 * Fetch content from an ipfs:// URL by trying multiple gateways.
 * Returns the result from the first gateway that succeeds.
 */
async function fetchIpfsProtocol(ipfsUrl: string): Promise<FetchResult> {
  let lastError: Error | null = null

  for (const gateway of IPFS_GATEWAYS) {
    const gatewayUrl = ipfsToGatewayUrl(ipfsUrl, gateway)
    if (!gatewayUrl) {
      continue
    }

    try {
      return await fetchDirectly(gatewayUrl)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Unknown error')
      // Continue to next gateway
    }
  }

  throw lastError || new Error('All IPFS gateways failed')
}

/**
 * Fetch content for a URL.
 * - ipfs:// URLs: tries multiple gateways
 * - IPFS gateway URLs: fetches directly (CORS enabled)
 * - Other URLs: uses CORS proxy with fallbacks
 */
async function fetchContent(url: string): Promise<FetchResult> {
  // Handle ipfs:// protocol URLs with gateway fallback
  if (isIpfsProtocol(url)) {
    return fetchIpfsProtocol(url)
  }

  // Handle IPFS gateway URLs directly
  if (isIpfsUrl(url)) {
    return fetchDirectly(url)
  }

  // CORS proxies don't preserve Content-Type reliably, so treat as HTML
  const content = await fetchViaProxy(url)
  return { content, contentType: 'text/html' }
}

async function fetchRichPreview(url: string): Promise<LinkPreviewData> {
  // Check cache first
  const cached = previewCache.get(url)
  if (cached) {
    return cached
  }

  // Check for pending request (deduplication)
  const pending = pendingRequests.get(url)
  if (pending) {
    return pending
  }

  // Create new request - uses direct fetch for IPFS, CORS proxy for others
  const request = (async () => {
    try {
      const { content, contentType } = await fetchContent(url)

      // If content is an image (common for IPFS), return as direct image preview
      if (isImageContentType(contentType)) {
        const data = createDirectImagePreview(url)
        previewCache.set(url, data)
        return data
      }

      const data = parseHtmlForPreview(content, url)
      previewCache.set(url, data)
      return data
    } catch {
      // Return minimal data on error
      const fallback = createBasicPreview(url)
      previewCache.set(url, fallback)
      return fallback
    } finally {
      pendingRequests.delete(url)
    }
  })()

  pendingRequests.set(url, request)
  return request
}

/**
 * Create basic preview data from URL without any network requests
 * This is the privacy-preserving default
 */
function createBasicPreview(url: string): LinkPreviewData {
  try {
    const parsed = new URL(url)
    return {
      url,
      siteName: parsed.hostname.replace(/^www\./, ''),
      favicon: `${parsed.origin}/favicon.ico`,
    }
  } catch {
    return { url }
  }
}

/**
 * Create preview data for a URL that points directly to an image.
 * Used when Content-Type indicates image (e.g., IPFS images without file extensions).
 */
function createDirectImagePreview(url: string): LinkPreviewData {
  try {
    const parsed = new URL(url)
    return {
      url,
      siteName: parsed.hostname.replace(/^www\./, ''),
      favicon: `${parsed.origin}/favicon.ico`,
      isDirectImage: true,
    }
  } catch {
    return { url, isDirectImage: true }
  }
}

interface UseLinkPreviewOptions {
  /** Disable preview entirely */
  disabled?: boolean
}

interface UseLinkPreviewResult {
  data: LinkPreviewData | null
  loading: boolean
  error: boolean
}

/**
 * Hook to get link preview data for a URL
 *
 * When enabled, fetches full metadata (title, description, image) via third-party CORS proxy.
 * Returns null when disabled.
 */
export function useLinkPreview(
  url: string | null,
  options: UseLinkPreviewOptions = {}
): UseLinkPreviewResult {
  const { disabled = false } = options

  // Initialize data from cache if available
  const [data, setData] = useState<LinkPreviewData | null>(() => {
    if (!url || disabled || shouldSkipUrl(url)) return null
    return previewCache.get(url) || null
  })

  // Initialize loading state
  const [loading, setLoading] = useState(() => {
    if (!url || disabled || shouldSkipUrl(url)) return false
    return !previewCache.has(url)
  })

  const [error, setError] = useState(false)

  useEffect(() => {
    if (!url || disabled || shouldSkipUrl(url)) {
      setData(null)
      setLoading(false)
      setError(false)
      return
    }

    // Check cache first
    const cached = previewCache.get(url)
    if (cached) {
      setData(cached)
      setLoading(false)
      setError(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(false)

    fetchRichPreview(url)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [url, disabled])

  return {
    data,
    loading,
    error,
  }
}

/**
 * Strip trailing punctuation while preserving balanced parentheses
 * This handles URLs like https://en.wikipedia.org/wiki/Foo_(bar)
 */
export function stripTrailingPunctuation(url: string): string {
  // Characters to strip from end (excluding closing paren which needs balance check)
  const punctuation = /[.,;:!?]+$/

  // First strip simple punctuation
  let result = url.replace(punctuation, '')

  // Handle trailing closing parentheses - only remove if unbalanced
  while (result.endsWith(')')) {
    const openCount = (result.match(/\(/g) || []).length
    const closeCount = (result.match(/\)/g) || []).length

    // If more closing than opening, remove the trailing )
    if (closeCount > openCount) {
      result = result.slice(0, -1)
      // Strip any punctuation that was before the paren
      result = result.replace(punctuation, '')
    } else {
      // Balanced or more opening - keep the closing paren
      break
    }
  }

  return result
}

/**
 * Extract the first URL from content text.
 * Supports http://, https://, ipfs://, and www. URLs.
 */
export function extractFirstUrl(content: string): string | null {
  // Match http(s)://, ipfs://, or www. URLs
  const urlPattern = /(https?:\/\/[^\s<>\"\']+|ipfs:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/gi
  const match = content.match(urlPattern)
  if (!match?.[0]) return null

  let url = match[0]
  // Add protocol if missing (for www. URLs)
  if (url.toLowerCase().startsWith('www.')) {
    url = `https://${url}`
  }
  // Clean trailing punctuation while preserving balanced parens
  url = stripTrailingPunctuation(url)

  return url
}

/**
 * Extract all URLs from content text.
 * Supports http://, https://, ipfs://, and www. URLs.
 */
export function extractAllUrls(content: string): string[] {
  // Match http(s)://, ipfs://, or www. URLs
  const urlPattern = /(https?:\/\/[^\s<>\"\']+|ipfs:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/gi
  const matches = content.match(urlPattern)
  if (!matches) return []

  return matches.map(url => {
    // Add protocol if missing (for www. URLs)
    if (url.toLowerCase().startsWith('www.')) {
      url = `https://${url}`
    }
    // Clean trailing punctuation while preserving balanced parens
    return stripTrailingPunctuation(url)
  })
}

/**
 * Prefetch link previews for multiple URLs (useful for feed)
 * Only works when rich previews are enabled
 */
export function prefetchLinkPreviews(urls: string[]): void {
  urls.forEach(url => {
    if (!shouldSkipUrl(url) && !previewCache.has(url)) {
      fetchRichPreview(url).catch(() => {
        // Ignore errors during prefetch
      })
    }
  })
}

/**
 * Clear the preview cache (useful for testing)
 */
export function clearPreviewCache(): void {
  previewCache.clear()
}
