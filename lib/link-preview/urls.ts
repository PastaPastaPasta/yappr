/**
 * URL recognition for link previews: which links are YouTube videos, direct
 * images, Yappr posts, or not worth previewing at all. Pure; no network.
 */

import { isIpfsProtocol } from '@/lib/utils/ipfs-gateway'

const YOUTUBE_DOMAINS = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com']
const YAPPR_POST_HOSTS = new Set(['yap.pr', 'www.yap.pr'])
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']
/** Hosts that never have a useful preview. */
const SKIP_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0']

function normalizeOrigin(origin?: string): string | null {
  if (!origin) return null
  try {
    return new URL(origin).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The post id from a URL that targets this app's post route, or null.
 * Absolute URLs only. Accepts `https://yap.pr/post/?id=ID`, the same on
 * `www.yap.pr` or the current origin, and a `/post/ID` path fallback.
 */
export function extractYapprPostId(url: string, currentOrigin?: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const normalizedCurrentOrigin =
      normalizeOrigin(currentOrigin) ?? (typeof window !== 'undefined' ? normalizeOrigin(window.location.origin) : null)
    const isSameOrigin = normalizedCurrentOrigin ? parsed.origin.toLowerCase() === normalizedCurrentOrigin : false
    if (!YAPPR_POST_HOSTS.has(hostname) && !isSameOrigin) return null

    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) return null
    const last = segments[segments.length - 1].toLowerCase()
    const penultimate = segments.length > 1 ? segments[segments.length - 2].toLowerCase() : null
    if (last !== 'post' && penultimate !== 'post') return null

    const idParam = parsed.searchParams.get('id')?.trim()
    if (idParam) return idParam
    if (penultimate === 'post') {
      const pathId = decodeURIComponent(segments[segments.length - 1]).trim()
      if (pathId) return pathId
    }
    return null
  } catch {
    return null
  }
}

/**
 * The video id from a YouTube URL, or null. Handles `watch?v=`, `youtu.be/`,
 * and the `/embed/`, `/v/`, `/shorts/`, `/live/` paths.
 */
export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (!YOUTUBE_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) return null

    if (hostname === 'youtu.be') {
      return parsed.pathname.slice(1).split('/')[0] || null
    }
    const vParam = parsed.searchParams.get('v')
    if (vParam) return vParam
    const pathMatch = parsed.pathname.match(/\/(embed|v|shorts|live)\/([^/?]+)/)
    return pathMatch ? pathMatch[2] : null
  } catch {
    return null
  }
}

export function isYouTubeUrl(url: string): boolean {
  return extractYouTubeVideoId(url) !== null
}

/** Whether the path ends in an image extension; such links get the large image layout. */
export function isDirectImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}

/** Whether a URL should get no preview at all: local hosts, or unparseable. `ipfs://` is never skipped. */
export function shouldSkipPreview(url: string): boolean {
  if (isIpfsProtocol(url)) return false
  try {
    const hostname = new URL(url).hostname
    return SKIP_HOSTS.some((host) => hostname.includes(host))
  } catch {
    return true
  }
}

/** Strip trailing sentence punctuation, keeping a `)` that balances an earlier `(`. */
export function stripTrailingPunctuation(url: string): string {
  const punctuation = /[.,;:!?]+$/
  let result = url.replace(punctuation, '')
  while (result.endsWith(')')) {
    const opens = (result.match(/\(/g) || []).length
    const closes = (result.match(/\)/g) || []).length
    if (closes <= opens) break
    result = result.slice(0, -1).replace(punctuation, '')
  }
  return result
}

/** The first `http(s)://`, `ipfs://` or `www.` URL in some text, cleaned, or null. */
export function extractFirstUrl(content: string): string | null {
  const match = content.match(/(https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i)
  if (!match?.[0]) return null
  let url = match[0]
  if (url.toLowerCase().startsWith('www.')) url = `https://${url}`
  return stripTrailingPunctuation(url)
}
