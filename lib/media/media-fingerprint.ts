/**
 * Browser side of the v10 media hashes: `mediaHash` (sha256 of the exact bytes
 * uploaded) and `mediaFingerprint` (the dHash pinned in ./dhash). Decoding
 * uses `createImageBitmap` with the image's own orientation applied and draws
 * over opaque white at full resolution, in bands of rows, so the uploader and
 * every reader feed the same pixels into the same accumulator.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesEqual, bytesToHex } from '@/lib/bytes'
import { createDHashAccumulator, mediaFingerprintChanged } from './dhash'

export interface MediaHashes {
  /** sha256 of the exact uploaded bytes (32 bytes). */
  mediaHash: Uint8Array
  /** The 8-byte dHash of the decoded image. */
  mediaFingerprint: Uint8Array
}

/** Rows drawn per pass: bounds the canvas to width × 256 pixels however tall the image is. */
const BAND_ROWS = 256

/** The dHash of an encoded image. Rejects when the browser cannot decode it. */
export async function fingerprintImage(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const { width, height } = bitmap
    const accumulator = createDHashAccumulator(width, height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.min(BAND_ROWS, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context unavailable')
    for (let y = 0; y < height; y += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, height - y)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, canvas.height)
      context.drawImage(bitmap, 0, -y)
      accumulator.addRows(context.getImageData(0, 0, width, rows).data, y, rows)
    }
    return accumulator.digest()
  } finally {
    bitmap.close()
  }
}

/** Both v10 media hashes for a file about to be uploaded. */
export async function computeMediaHashes(file: Blob): Promise<MediaHashes> {
  const [bytes, mediaFingerprint] = await Promise.all([
    file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    fingerprintImage(file),
  ])
  return { mediaHash: sha256(bytes), mediaFingerprint }
}

/**
 * Whether the image at `url` is no longer the one that was posted: the bytes
 * differ from `mediaHash` AND the picture's fingerprint is more than
 * `MEDIA_CHANGED_DISTANCE` (12) bits from `mediaFingerprint`. A re-encoded
 * copy of the same picture passes. Resolves null when the image cannot be
 * fetched or decoded here (a gateway without CORS, say): nothing is known,
 * so nothing is claimed.
 */
export function checkServedMedia(url: string, posted: MediaHashes): Promise<boolean | null> {
  // One check per served URL and posted hash at a time: a card that remounts
  // (feed scroll, navigation) reuses a pending or recent check rather than
  // downloading the image again. A verdict is only trusted for
  // SERVED_CHECK_TTL_MS, since the bytes behind a URL can change; a check that
  // could not run is dropped as soon as it settles, so the next load retries.
  const key = `${url}#${bytesToHex(posted.mediaHash)}`
  const cached = servedChecks.get(key)
  if (cached && (cached.expiresAt === undefined || Date.now() < cached.expiresAt)) return cached.check
  servedChecks.delete(key)
  if (servedChecks.size >= MAX_SERVED_CHECKS) {
    const oldest = servedChecks.keys().next()
    if (!oldest.done) servedChecks.delete(oldest.value)
  }
  const entry: ServedCheck = { check: runServedCheck(url, posted) }
  servedChecks.set(key, entry)
  entry.check.then((result) => {
    if (servedChecks.get(key) !== entry) return
    if (result === null) servedChecks.delete(key)
    else entry.expiresAt = Date.now() + SERVED_CHECK_TTL_MS
  }, () => servedChecks.delete(key))
  return entry.check
}

interface ServedCheck {
  check: Promise<boolean | null>
  /** Unset while the check is in flight. */
  expiresAt?: number
}

const MAX_SERVED_CHECKS = 200
/** How long a completed verdict for a served URL is reused before re-fetching. */
const SERVED_CHECK_TTL_MS = 5 * 60 * 1000
const servedChecks = new Map<string, ServedCheck>()

async function runServedCheck(url: string, posted: MediaHashes): Promise<boolean | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytesEqual(sha256(bytes), posted.mediaHash)) return false
    return mediaFingerprintChanged(posted.mediaFingerprint, await fingerprintImage(blob))
  } catch {
    return null
  }
}
