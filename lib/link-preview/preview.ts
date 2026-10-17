/**
 * Preview data for a URL. YouTube, image and ordinary web links are built
 * from the URL alone; only IPFS and allow-listed hosts are fetched and parsed
 * (./fetch). Results are cached for the page's lifetime and concurrent
 * requests for one URL share a fetch.
 */

import type { LinkPreviewData } from './types'
import { extractYouTubeVideoId, isDirectImageUrl } from './urls'
import { canFetchPreview, fetchPreviewContent, isImageContentType } from './fetch'
import { parseHtmlForPreview } from './parse-html'

const previewCache = new Map<string, LinkPreviewData>()
const pendingPreviews = new Map<string, Promise<LinkPreviewData>>()

/** What we can say about a URL without contacting its site: its host. */
function basicPreview(url: string): LinkPreviewData {
  try {
    return { url, siteName: new URL(url).hostname.replace(/^www\./, '') }
  } catch {
    return { url }
  }
}

function directImagePreview(url: string): LinkPreviewData {
  return { ...basicPreview(url), isDirectImage: true }
}

function youTubePreview(url: string, videoId: string): LinkPreviewData {
  return {
    url,
    siteName: 'YouTube',
    youtubeVideoId: videoId,
  }
}

async function buildPreview(url: string): Promise<LinkPreviewData> {
  if (isDirectImageUrl(url)) return directImagePreview(url)
  const videoId = extractYouTubeVideoId(url)
  if (videoId) return youTubePreview(url, videoId)
  if (!canFetchPreview(url)) return basicPreview(url)

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
export function getLinkPreview(url: string): Promise<LinkPreviewData> {
  const cached = previewCache.get(url)
  if (cached) return Promise.resolve(cached)
  const pending = pendingPreviews.get(url)
  if (pending) return pending

  const request = buildPreview(url)
    .catch(() => basicPreview(url))
    .then((data) => {
      previewCache.set(url, data)
      return data
    })
    .finally(() => pendingPreviews.delete(url))
  pendingPreviews.set(url, request)
  return request
}
