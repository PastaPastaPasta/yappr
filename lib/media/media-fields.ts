import { mediaCarriesHashes, mediaIsArrays, mediaItemLimit } from '@/lib/contract-topology'
import { normalizeBytes } from '@/lib/bytes'
import { normalizeMediaUrl } from '@/lib/utils/ipfs-gateway'
import type { Media } from '@/lib/types'
import type { MediaHashes } from './media-fingerprint'

/** What a post or reply shows at one media slot. */
export type MediaType = Media['type']

/** One media item about to be written: its stored URL, its hashes (v10+) and what it is. */
export interface MediaItemInput {
  /** As stored (`mediaUrlForContract`). */
  url: string
  /** Required on v10 and later (see `mediaCarriesHashes()`). */
  hashes?: MediaHashes
  /** Default `image`. */
  type?: MediaType
}

/** The kind byte v13 stores per item in `mediaKinds`. Readers ignore any other byte. */
const KIND_BYTES: Readonly<Record<MediaType, number>> = { image: 0, video: 1, gif: 2 }
const KIND_OF_BYTE: readonly MediaType[] = ['image', 'video', 'gif']

const HASH_BYTES = 32
const FINGERPRINT_BYTES = 8
/** One `mediaDigests` entry: the sha256 of the bytes, then the 64-bit fingerprint. */
export const MEDIA_DIGEST_BYTES = HASH_BYTES + FINGERPRINT_BYTES

/** What a file of MIME type `mime` shows as: a GIF, a video, or an image (the default). */
export function mediaTypeOfMime(mime: string | undefined): MediaType {
  if (mime === 'image/gif') return 'gif'
  return mime?.startsWith('video/') ? 'video' : 'image'
}

/** One item's 40-byte `mediaDigests` entry. */
export function encodeMediaDigest(hashes: MediaHashes): Uint8Array {
  if (hashes.mediaHash.length !== HASH_BYTES || hashes.mediaFingerprint.length !== FINGERPRINT_BYTES) {
    throw new Error('A media digest is a 32-byte sha256 and an 8-byte fingerprint')
  }
  const digest = new Uint8Array(MEDIA_DIGEST_BYTES)
  digest.set(hashes.mediaHash, 0)
  digest.set(hashes.mediaFingerprint, HASH_BYTES)
  return digest
}

/**
 * The hashes of each of `count` items packed in `digests`, or none when the
 * bytes do not hold exactly one 40-byte entry per item (consensus refuses
 * that, so only a malformed read produces it).
 */
export function decodeMediaDigests(digests: Uint8Array | null, count: number): Array<MediaHashes | undefined> {
  if (!digests || digests.length !== count * MEDIA_DIGEST_BYTES) return Array.from({ length: count }, () => undefined)
  return Array.from({ length: count }, (_, index) => {
    const start = index * MEDIA_DIGEST_BYTES
    return {
      mediaHash: digests.slice(start, start + HASH_BYTES),
      mediaFingerprint: digests.slice(start + HASH_BYTES, start + MEDIA_DIGEST_BYTES),
    }
  })
}

/**
 * The media properties a post or reply create writes.
 *
 * - **v13**: `mediaUrls`, `mediaDigests` (one 40-byte digest per item) and
 *   `mediaKinds` (one byte per item), up to `mediaItemLimit()` items. The
 *   `media` rule makes their lengths agree, so every item needs its hashes.
 * - **v10-v12**: one `mediaUrl` with `mediaHash` and `mediaFingerprint`
 *   (`dependentRequired`, 10101 otherwise).
 * - **v2, v9**: one `mediaUrl`.
 *
 * Anything the contract would refuse (too many items, an item without its
 * hashes) throws here instead of being charged for there.
 */
export function mediaDocumentFields(items: readonly MediaItemInput[] | undefined): Record<string, unknown> {
  if (!items || items.length === 0) return {}
  const limit = mediaItemLimit()
  if (items.length > limit) throw new Error(limit === 1 ? 'Only one image can be attached here.' : `Attach at most ${limit} images or videos.`)
  if (mediaCarriesHashes() && items.some((item) => !item.hashes)) {
    throw new Error('This image is missing its content hashes. Remove it and attach it again.')
  }
  if (mediaIsArrays()) {
    const digests = new Uint8Array(items.length * MEDIA_DIGEST_BYTES)
    items.forEach((item, index) => digests.set(encodeMediaDigest(item.hashes as MediaHashes), index * MEDIA_DIGEST_BYTES))
    return {
      mediaUrls: items.map((item) => item.url),
      mediaDigests: digests,
      mediaKinds: Uint8Array.from(items, (item) => KIND_BYTES[item.type ?? 'image']),
    }
  }
  const [{ url, hashes }] = items
  if (!mediaCarriesHashes() || !hashes) return { mediaUrl: url }
  return { mediaUrl: url, mediaHash: hashes.mediaHash, mediaFingerprint: hashes.mediaFingerprint }
}

/**
 * The media of a stored post or reply, with their hashes when the document
 * carries them: v13's `mediaUrls`/`mediaDigests`/`mediaKinds`, or the single
 * `mediaUrl` of earlier cuts. A kind byte this client does not know is ignored
 * (consensus cannot check the bytes): the item shows as an image. `data` is the
 * document's property bag, `doc` the document itself (the SDK may put
 * properties at either level).
 */
export function mediaFromDocument(id: string, data: Record<string, unknown>, doc: Record<string, unknown>): Media[] | undefined {
  const urls = data.mediaUrls ?? doc.mediaUrls
  if (Array.isArray(urls)) {
    const valid = urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
    if (valid.length === 0 || valid.length !== urls.length) return undefined
    const hashes = decodeMediaDigests(normalizeBytes(data.mediaDigests ?? doc.mediaDigests), valid.length)
    const kinds = normalizeBytes(data.mediaKinds ?? doc.mediaKinds)
    return valid.map((url, index) => ({
      id: `${id}-media-${index}`,
      type: KIND_OF_BYTE[kinds?.[index] ?? 0] ?? 'image',
      url: normalizeMediaUrl(url),
      ...(hashes[index] ? { hashes: hashes[index] } : {}),
    }))
  }
  const mediaUrl = (data.mediaUrl || doc.mediaUrl) as string | undefined
  if (!mediaUrl) return undefined
  const mediaHash = normalizeBytes(data.mediaHash ?? doc.mediaHash)
  const mediaFingerprint = normalizeBytes(data.mediaFingerprint ?? doc.mediaFingerprint)
  return [{
    id: id + '-media',
    type: 'image',
    url: normalizeMediaUrl(mediaUrl),
    ...(mediaHash?.length === HASH_BYTES && mediaFingerprint?.length === FINGERPRINT_BYTES ? { hashes: { mediaHash, mediaFingerprint } } : {}),
  }]
}
