/**
 * Local Image Cache
 *
 * Maps freshly uploaded IPFS CIDs to local object URLs so the uploader sees
 * their image immediately, without waiting for public gateways to propagate
 * the content (which can take minutes for a fresh upload).
 */

import { extractCidFromIpfsUrl } from '@/lib/utils/ipfs-gateway'

const MAX_ENTRIES = 50

// cid -> object URL, in insertion order (Map preserves it) for oldest-first eviction
const cache = new Map<string, string>()

/**
 * Register a locally available file for a CID that was just uploaded.
 * The object URL lives for the session (or until evicted).
 */
export function cacheLocalImage(cid: string, file: Blob): void {
  if (!cid || cache.has(cid)) return

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.entries().next()
    if (!oldest.done) {
      URL.revokeObjectURL(oldest.value[1])
      cache.delete(oldest.value[0])
    }
  }

  cache.set(cid, URL.createObjectURL(file))
}

/**
 * Look up a local object URL for an ipfs:// URL (bare CID only, no subpath).
 * Returns null when the content wasn't uploaded in this session.
 */
export function getLocalImageUrl(ipfsUrl: string): string | null {
  const parsed = extractCidFromIpfsUrl(ipfsUrl)
  if (!parsed || parsed.path) return null
  return cache.get(parsed.cid) ?? null
}
