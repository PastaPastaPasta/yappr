'use client'

import { useState, useEffect } from 'react'
import type { LinkPreviewData } from '@/components/post/link-preview'

// Client-side cache for link previews
const previewCache = new Map<string, LinkPreviewData>()
const pendingRequests = new Map<string, Promise<LinkPreviewData>>()

/**
 * CORS Proxy Configuration
 *
 * PRIVACY/SECURITY NOTE: These are third-party CORS proxies that will see
 * the URLs being fetched. For production use with sensitive data, consider:
 * - Self-hosting a CORS proxy
 * - Moving URL fetching to a backend API endpoint
 * - Using a serverless function to proxy requests
 *
 * The proxies are tried in order; if one fails, the next is attempted.
 */
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

  const image = makeAbsoluteUrl(imageRaw, url)
  const favicon = extractFavicon(html, url)

  return {
    url,
    title,
    description,
    image,
    siteName,
    favicon,
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

async function fetchPreview(url: string): Promise<LinkPreviewData> {
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

  // Create new request using CORS proxy with fallbacks
  const request = (async () => {
    try {
      const html = await fetchViaProxy(url)
      const data = parseHtmlForPreview(html, url)
      previewCache.set(url, data)
      return data
    } catch {
      // Return minimal data on error
      const fallback: LinkPreviewData = { url }
      previewCache.set(url, fallback)
      return fallback
    } finally {
      pendingRequests.delete(url)
    }
  })()

  pendingRequests.set(url, request)
  return request
}

interface UseLinkPreviewOptions {
  /** Disable fetching */
  disabled?: boolean
}

interface UseLinkPreviewResult {
  data: LinkPreviewData | null
  loading: boolean
  error: boolean
}

/**
 * Hook to fetch link preview data for a URL
 * Uses CORS proxies to fetch page metadata client-side
 *
 * Note: This sends URLs to third-party CORS proxy services.
 * For privacy-sensitive applications, consider implementing
 * a server-side proxy endpoint instead.
 */
export function useLinkPreview(
  url: string | null,
  options: UseLinkPreviewOptions = {}
): UseLinkPreviewResult {
  const { disabled = false } = options

  // Initialize data from cache if available
  const [data, setData] = useState<LinkPreviewData | null>(() => {
    if (!url || disabled) return null
    return previewCache.get(url) || null
  })

  // Initialize loading to true if we need to fetch (URL exists, not disabled, not cached)
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

    fetchPreview(url)
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

  return { data, loading, error }
}

/**
 * Strip trailing punctuation while preserving balanced parentheses
 * This handles URLs like https://en.wikipedia.org/wiki/Foo_(bar)
 */
function stripTrailingPunctuation(url: string): string {
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
 */
export function prefetchLinkPreviews(urls: string[]): void {
  urls.forEach(url => {
    if (!shouldSkipUrl(url) && !previewCache.has(url)) {
      fetchPreview(url).catch(() => {
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
