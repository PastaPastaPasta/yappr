import { DHASH_COLUMNS, DHASH_ROWS, dHashFromImageData } from './dhash'
import { ipfsToGatewayUrl, isIpfsProtocol } from '@/lib/utils/ipfs-gateway'
import type { ImageDigest } from '@/lib/profile/v10-profile'

/**
 * The sha256 of the exact bytes at an image URL and the dHash of the decoded
 * image (`lib/media/dhash.ts`): what DashPay's `avatarHash` and
 * `avatarFingerprint` store beside `avatarUrl`. Browser only: it decodes and
 * downscales with a canvas. Consensus never fetches the URL, so these are
 * computed here, once, when the URL is written.
 */
export async function imageDigestForUrl(url: string): Promise<ImageDigest> {
  const response = await fetch(isIpfsProtocol(url) ? ipfsToGatewayUrl(url) : url)
  if (!response.ok) {
    throw new Error(`Could not read the image to fingerprint it (HTTP ${response.status})`)
  }
  const blob = await response.blob()
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))

  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const canvas = document.createElement('canvas')
    canvas.width = DHASH_COLUMNS
    canvas.height = DHASH_ROWS
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not fingerprint the image: no 2D canvas')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, DHASH_COLUMNS, DHASH_ROWS)
    return { hash, fingerprint: dHashFromImageData(context.getImageData(0, 0, DHASH_COLUMNS, DHASH_ROWS)) }
  } finally {
    bitmap.close()
  }
}
