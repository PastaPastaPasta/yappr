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
 * Check if a URL points to IPFS content.
 * IPFS gateways typically have CORS headers enabled, so we can fetch directly.
 *
 * Matches:
 * - Subdomain gateways: hostname contains "ipfs." (e.g., gateway.ipfs.io, bafybeib.ipfs.dweb.link)
 * - Path gateways: path starts with /ipfs/ (e.g., https://gateway.pinata.cloud/ipfs/Qm...)
 */
export function isIpfsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    // Check for subdomain gateway pattern: *.ipfs.* or hostname contains .ipfs.
    // Also matches gateway.ipfs.io style domains
    if (hostname.includes('.ipfs.') || hostname.includes('ipfs.')) {
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

/**
 * Fetch HTML directly without CORS proxy.
 * Used for IPFS gateways which typically have CORS headers enabled.
 */
async function fetchDirectly(url: string): Promise<string> {
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

    return await response.text()
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
 * Fetch HTML content for a URL.
 * Uses direct fetch for IPFS URLs (which have CORS enabled),
 * otherwise uses CORS proxy with fallbacks.
 */
async function fetchHtmlContent(url: string): Promise<string> {
  if (isIpfsUrl(url)) {
    return fetchDirectly(url)
  }
  return fetchViaProxy(url)
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
      const html = await fetchHtmlContent(url)
      const data = parseHtmlForPreview(html, url)
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
 * Extract the first URL from content text
 */
export function extractFirstUrl(content: string): string | null {
  const urlPattern = /(https?:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/gi
  const match = content.match(urlPattern)
  if (!match?.[0]) return null

  let url = match[0]
  // Add protocol if missing
  if (url.startsWith('www.')) {
    url = `https://${url}`
  }
  // Clean trailing punctuation while preserving balanced parens
  url = stripTrailingPunctuation(url)

  return url
}

/**
 * Extract all URLs from content text
 */
export function extractAllUrls(content: string): string[] {
  const urlPattern = /(https?:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/gi
  const matches = content.match(urlPattern)
  if (!matches) return []

  return matches.map(url => {
    // Add protocol if missing
    if (url.startsWith('www.')) {
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
