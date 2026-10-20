import { base64ToBytes } from '@/lib/bytes'
import { decryptDigitalFile, FILE_CIPHERTEXT_OVERHEAD } from '@/lib/crypto/digital-delivery'
import { getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import type { DigitalAsset } from '@/lib/types'

/**
 * A delivered file downloaded and decrypted, as lib's `fetchDecryptedFile`
 * does (lib/services/digital-file-service.ts), but without importing that
 * module: it also uploads, and its upload providers would bring the whole
 * Storacha and Pinata clients into the engine bundle.
 *
 * Each IPFS gateway is tried in turn. A gateway that answers with the wrong
 * bytes fails authentication, and the next one is tried. The URL can carry
 * the seller's secret, so it is never put in an error.
 */

/** No byte from a gateway for this long ends that attempt. */
const IDLE_TIMEOUT_MS = 30_000

async function download(url: string, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const extend = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  }
  extend()
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('too large')
    if (!response.body) return new Uint8Array(await response.arrayBuffer())
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      extend()
      received += value.length
      if (received > maxBytes) {
        await reader.cancel()
        throw new Error('too large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** The plaintext of `asset`, at most `maxBytes`; throws once every gateway failed. */
export async function fetchDeliveredFile(asset: Extract<DigitalAsset, { kind: 'file' }>, maxBytes: number): Promise<Uint8Array> {
  const key = base64ToBytes(asset.key)
  for (const url of getAllGatewayUrls(asset.url)) {
    try {
      return decryptDigitalFile(await download(url, maxBytes + FILE_CIPHERTEXT_OVERHEAD), key)
    } catch {
      // The next gateway.
    }
  }
  throw new Error('Could not download this file from any IPFS gateway. Try again in a few minutes.')
}
