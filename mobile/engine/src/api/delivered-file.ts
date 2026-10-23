import { md5 } from '@noble/hashes/legacy.js'
import { base64ToBytes, bytesToHex } from '@/lib/bytes'
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
 *
 * The plaintext never crosses the bridge whole (MARCH-1): the engine holds
 * it ({@link holdDeliveredFile}) and the host reads it in chunks of at most
 * {@link DELIVERED_FILE_CHUNK_BYTES}, appending each to its file, so no
 * string the size of the file exists in the WebView, the bridge or Hermes.
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
    const declared = Number(response.headers.get('content-length'))
    if (declared > maxBytes) throw new Error('too large')
    if (!response.body) return new Uint8Array(await response.arrayBuffer())
    const reader = response.body.getReader()
    // The declared length gets one buffer up front, so the file is not held twice to be joined at the end.
    let bytes = new Uint8Array(Number.isSafeInteger(declared) && declared > 0 ? declared : 1 << 16)
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      extend()
      if (received + value.length > maxBytes) {
        await reader.cancel()
        throw new Error('too large')
      }
      if (received + value.length > bytes.length) {
        // No length, or a wrong one: grow.
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(bytes.length * 2, received + value.length)))
        grown.set(bytes.subarray(0, received))
        bytes = grown
      }
      bytes.set(value, received)
      received += value.length
    }
    return received === bytes.length ? bytes : bytes.subarray(0, received)
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

/** The most plaintext one `store.deliveredFileChunk` answer carries (about 350 KB of JSON once base64 encoded). */
export const DELIVERED_FILE_CHUNK_BYTES = 256 * 1024
/** A held file nobody read from for this long is dropped. */
const HELD_IDLE_MS = 2 * 60_000
/** Decrypted files waiting to be read at once; opening another drops the oldest. */
const MAX_HELD = 2
const CLOSED_MESSAGE = 'This file is no longer open. Save it again.'

interface HeldFile {
  owner: string
  bytes: Uint8Array
  timer: ReturnType<typeof setTimeout>
}

const held = new Map<string, HeldFile>()

/** A decrypted file the engine holds for the host to read in chunks (`store.deliveredFileChunk`). */
export interface HeldFileDTO {
  /** Names the file to `deliveredFileChunk` and `closeDeliveredFile`. */
  handle: string
  name: string
  /** Its length in bytes. */
  size: number
  /**
   * Hex MD5 of the plaintext, for the host to check the file it assembled
   * (a lost, repeated or reordered chunk). An assembly check only: the
   * decryption's AEAD tag is what authenticated the bytes.
   */
  md5: string
}

export function releaseDeliveredFile(handle: string): void {
  const file = held.get(handle)
  if (!file) return
  clearTimeout(file.timer)
  held.delete(handle)
}

const idleTimer = (handle: string) => setTimeout(() => releaseDeliveredFile(handle), HELD_IDLE_MS)

/**
 * Hold `bytes` for `owner` to read in chunks. An empty file has nothing to
 * read, so it is not held (the host reads no chunk of it, and closing its
 * handle is a no-op).
 */
export function holdDeliveredFile(owner: string, name: string, bytes: Uint8Array): HeldFileDTO {
  const handle = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  if (bytes.length > 0) {
    while (held.size >= MAX_HELD) releaseDeliveredFile(held.keys().next().value as string)
    held.set(handle, { owner, bytes, timer: idleTimer(handle) })
  }
  return { handle, name, size: bytes.length, md5: bytesToHex(md5(bytes)) }
}

const opening = new Map<string, Promise<HeldFileDTO>>()

/**
 * `open()` once per `key` at a time: a retry of an open its caller gave up on
 * (the host's deadline; an open is never cancelled in the engine) joins the
 * download still running instead of starting a second one. Whoever reads the
 * result first gets the file; one nobody reads is let go when idle.
 */
export function openOnce(key: string, open: () => Promise<HeldFileDTO>): Promise<HeldFileDTO> {
  const running = opening.get(key)
  if (running) return running
  const started = open().finally(() => opening.delete(key))
  opening.set(key, started)
  return started
}

/**
 * The held file's bytes from `offset`: at most {@link DELIVERED_FILE_CHUNK_BYTES},
 * empty at the end. The chunk that reaches the end releases the file. Only
 * `owner`, the account that opened it, reads it; another account's read
 * drops it.
 */
export function readDeliveredFileChunk(owner: string, handle: string, offset: number): Uint8Array {
  const file = held.get(handle)
  if (!file) throw new Error(CLOSED_MESSAGE)
  if (file.owner !== owner) {
    releaseDeliveredFile(handle)
    throw new Error(CLOSED_MESSAGE)
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes.length) throw new Error('offset is out of range')
  const chunk = file.bytes.subarray(offset, offset + DELIVERED_FILE_CHUNK_BYTES)
  clearTimeout(file.timer)
  if (offset + chunk.length >= file.bytes.length) held.delete(handle)
  else file.timer = idleTimer(handle)
  return chunk
}
