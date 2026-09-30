import { mediaCarriesHashes } from '@/lib/contract-topology'
import { normalizeBytes } from '@/lib/bytes'
import { normalizeMediaUrl } from '@/lib/utils/ipfs-gateway'
import type { Media } from '@/lib/types'
import type { MediaHashes } from './media-fingerprint'

/**
 * The media properties a post or reply create writes. On v10 a `mediaUrl`
 * must come with `mediaHash` and `mediaFingerprint` and neither may come
 * without it (`dependentRequired`, 10101), so a URL without hashes is refused
 * here instead of being charged for there. Elsewhere only the URL is written.
 */
export function mediaDocumentFields(mediaUrl: string | undefined, hashes: MediaHashes | undefined): Record<string, unknown> {
  if (!mediaUrl) return {}
  if (!mediaCarriesHashes()) return { mediaUrl }
  if (!hashes) throw new Error('This image is missing its content hashes. Remove it and attach it again.')
  return { mediaUrl, mediaHash: hashes.mediaHash, mediaFingerprint: hashes.mediaFingerprint }
}

/**
 * The single media entry of a stored post or reply, with its v10 hashes when
 * the document carries them. `data` is the document's property bag, `doc` the
 * document itself (the SDK may put properties at either level).
 */
export function mediaFromDocument(id: string, data: Record<string, unknown>, doc: Record<string, unknown>): Media[] | undefined {
  const mediaUrl = (data.mediaUrl || doc.mediaUrl) as string | undefined
  if (!mediaUrl) return undefined
  const mediaHash = normalizeBytes(data.mediaHash ?? doc.mediaHash)
  const mediaFingerprint = normalizeBytes(data.mediaFingerprint ?? doc.mediaFingerprint)
  return [{
    id: id + '-media',
    type: 'image',
    url: normalizeMediaUrl(mediaUrl),
    ...(mediaHash?.length === 32 && mediaFingerprint?.length === 8 ? { hashes: { mediaHash, mediaFingerprint } } : {}),
  }]
}
