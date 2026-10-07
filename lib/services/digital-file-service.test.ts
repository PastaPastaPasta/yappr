import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../upload', () => ({
  getUploadProvider: vi.fn(),
  UploadErrorCode: {},
  UploadException: class extends Error {},
}))

import { bytesToBase64 } from '../bytes'
import { encryptDigitalFile, FILE_CIPHERTEXT_OVERHEAD } from '../crypto/digital-delivery'
import { MAX_DIGITAL_FILE_BYTES } from './digital-delivery-plan'
import { fetchDecryptedFile, type DigitalFileAsset } from './digital-file-service'

const asset = (key: Uint8Array): DigitalFileAsset =>
  ({ kind: 'file', name: 'book.pdf', size: 3, url: 'https://files.example/book.pdf.enc', key: bytesToBase64(key) })

/** A streamed body of `chunks` chunks of `size` bytes, recording how many were pulled and whether it was cancelled. */
function streamOf(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close()
      state.pulled++
      controller.enqueue(new Uint8Array(size))
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { body, state }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchDecryptedFile', () => {
  it('downloads and decrypts a file', async () => {
    const { ciphertext, key } = encryptDigitalFile(new Uint8Array([1, 2, 3]))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ciphertext)))
    const blob = await fetchDecryptedFile(asset(key))
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('stops reading a response once it passes the largest a delivered file can be', async () => {
    const chunk = 8 * 1024 * 1024
    const chunks = Math.ceil((MAX_DIGITAL_FILE_BYTES + FILE_CIPHERTEXT_OVERHEAD) / chunk) + 50
    const { body, state } = streamOf(chunks, chunk)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(fetchDecryptedFile(asset(new Uint8Array(32)))).rejects.toThrow()
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThan(chunks)
  })

  it('refuses a response whose Content-Length is already too large, without reading it', async () => {
    const { body, state } = streamOf(1, 16)
    const headers = { 'content-length': String(MAX_DIGITAL_FILE_BYTES + FILE_CIPHERTEXT_OVERHEAD + 1) }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers })))
    await expect(fetchDecryptedFile(asset(new Uint8Array(32)))).rejects.toThrow()
    expect(state.cancelled).toBe(true)
  })
})
