import type { LinkPreviewData } from './types'
import { extractYouTubeVideoId, isDirectImageUrl } from './urls'
import { fetchPreviewContent, isImageContentType } from './fetch'
import { parseHtmlForPreview } from './parse-html'

/**
 * Preview data for a URL. YouTube and image links are built from the URL
 * alone; anything else is fetched and parsed. Results are cached for the
 * page's lifetime and concurrent requests for one URL share a fetch.
 */

const previewCache = new Map<string, LinkPreviewData>()
const pendingRequests = new Map<string, Promise<LinkPreviewData>>()

function siteFromUrl(url: string): Pick<LinkPreviewData, 'siteName' | 'favicon'> {
  try {
    const parsed = new URL(url)
    return { siteName: parsed.hostname.replace(/^www\./, ''), favicon: `${parsed.origin}/favicon.ico` }
  } catch {
    return {}
  }
}

/** What we can say about a URL without fetching it. */
function basicPreview(url: string): LinkPreviewData {
  return { url, ...siteFromUrl(url) }
}

function directImagePreview(url: string): LinkPreviewData {
  return { ...basicPreview(url), isDirectImage: true }
}

function youTubePreview(url: string, videoId: string): LinkPreviewData {
  return {
    url,
    siteName: 'YouTube',
    // maxresdefault is not always present; the component falls back to hqdefault on error.
    image: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    youtubeVideoId: videoId,
  }
}

async function buildPreview(url: string): Promise<LinkPreviewData> {
  if (isDirectImageUrl(url)) return directImagePreview(url)
  const videoId = extractYouTubeVideoId(url)
  if (videoId) return youTubePreview(url, videoId)

  const { content, contentType, resolvedUrl } = await fetchPreviewContent(url)
  // For ipfs:// the resolved gateway URL is what a browser can actually load.
  const loadableUrl = resolvedUrl || url
  if (isImageContentType(contentType)) return directImagePreview(loadableUrl)
  return parseHtmlForPreview(content, loadableUrl)
}

export function getCachedPreview(url: string): LinkPreviewData | undefined {
  return previewCache.get(url)
}

/** Never rejects: on any failure the preview degrades to host name and favicon. */
export function fetchLinkPreview(url: string): Promise<LinkPreviewData> {
  const cached = previewCache.get(url)
  if (cached) return Promise.resolve(cached)
  const pending = pendingRequests.get(url)
  if (pending) return pending

  const request = buildPreview(url)
    .catch(() => basicPreview(url))
    .then((data) => {
      previewCache.set(url, data)
      return data
    })
    .finally(() => pendingRequests.delete(url))
  pendingRequests.set(url, request)
  return request
}
