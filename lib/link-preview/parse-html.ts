import type { LinkPreviewData } from './types'

/** Open Graph, Twitter card and plain `<meta>`/`<title>` extraction from raw HTML. No DOM. */

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** The first capture group of the first matching pattern, entity-decoded. */
function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeEntities(match[1])
  }
  return undefined
}

/** Both attribute orders of `<meta property="…" content="…">`. */
function metaProperty(name: string): RegExp[] {
  return [
    new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${name}["']`, 'i'),
  ]
}

/** Both attribute orders of `<meta name="…" content="…">`. */
function metaName(name: string): RegExp[] {
  return [
    new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, 'i'),
  ]
}

export function makeAbsoluteUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined
  if (url.startsWith('http')) return url
  if (url.startsWith('//')) return `https:${url}`
  try {
    return new URL(url, baseUrl).href
  } catch {
    return url
  }
}

const ICON_PATTERNS = [
  /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i,
  /<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i,
  /<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i,
]

function extractFavicon(html: string, baseUrl: string): string | undefined {
  for (const pattern of ICON_PATTERNS) {
    const match = html.match(pattern)
    if (match?.[1]) return makeAbsoluteUrl(match[1], baseUrl)
  }
  try {
    return `${new URL(baseUrl).origin}/favicon.ico`
  } catch {
    return undefined
  }
}

function positiveInt(value: string | undefined): number | undefined {
  const n = value ? parseInt(value, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseHtmlForPreview(html: string, url: string): LinkPreviewData {
  return {
    url,
    title: firstMatch(html, [...metaProperty('og:title'), ...metaName('twitter:title'), /<title[^>]*>([^<]+)<\/title>/i]),
    description: firstMatch(html, [
      ...metaProperty('og:description'),
      ...metaName('twitter:description'),
      ...metaName('description'),
    ]),
    image: makeAbsoluteUrl(firstMatch(html, [...metaProperty('og:image'), ...metaName('twitter:image')]), url),
    imageWidth: positiveInt(firstMatch(html, metaProperty('og:image:width'))),
    imageHeight: positiveInt(firstMatch(html, metaProperty('og:image:height'))),
    siteName: firstMatch(html, metaProperty('og:site_name')),
    favicon: extractFavicon(html, url),
  }
}
