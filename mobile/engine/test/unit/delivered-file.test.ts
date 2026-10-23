/**
 * Delivered files (MARCH-1): downloaded and decrypted as before, then held in
 * the engine and read across the bridge in bounded chunks instead of one
 * base64 string the size of the file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { encryptDigitalFile } from '@/lib/crypto/digital-delivery'
import type { DigitalAsset } from '@/lib/types'
import { parse, stringify } from '../../src/protocol/codec'
import {
  DELIVERED_FILE_CHUNK_BYTES, fetchDeliveredFile, holdDeliveredFile, readDeliveredFileChunk, releaseDeliveredFile,
} from '../../src/api/delivered-file'

const MiB = 1024 * 1024
const OWNER = 'buyer'
const asset = (key: Uint8Array): Extract<DigitalAsset, { kind: 'file' }> =>
  ({ kind: 'file', name: 'book.pdf', size: 0, url: 'https://files.example/book.pdf.enc', key: bytesToBase64(key) })
const md5Hex = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

/** A body streamed in `size`-byte pieces, as a gateway sends it. */
const streamed = (bytes: Uint8Array, size: number) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size))
    controller.close()
  },
})

/** Read a held file the way the host does: one `res` frame per chunk, through the real codec. */
function readThroughBridge({ handle, size }: { handle: string; size: number }) {
  const parts: Uint8Array[] = []
  let largestFrame = 0
  for (let offset = 0; offset < size;) {
    const frame = stringify({ t: 'res', v: 1, id: '1', ok: true, value: readDeliveredFileChunk(OWNER, handle, offset) })
    largestFrame = Math.max(largestFrame, frame.length)
    const chunk = (parse(frame) as { value: Uint8Array }).value
    parts.push(chunk)
    offset += chunk.length
  }
  const assembled = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    assembled.set(part, at)
    at += part.length
  }
  return { assembled, chunks: parts.length, largestFrame }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchDeliveredFile', () => {
  it.each([
    ['with a declared length', true],
    ['without one', false],
  ])('downloads and decrypts a file streamed in pieces, %s', async (_label, declared) => {
    const plaintext = new Uint8Array(randomBytes(MiB + 17))
    const { ciphertext, key } = encryptDigitalFile(plaintext)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamed(ciphertext, 65_521), {
      headers: declared ? { 'content-length': String(ciphertext.length) } : {},
    })))
    expect(await fetchDeliveredFile(asset(key), 25 * MiB)).toEqual(plaintext)
  })

  it('refuses bytes that fail authentication from every gateway (the AEAD check is kept)', async () => {
    const { ciphertext, key } = encryptDigitalFile(new Uint8Array(randomBytes(4096)))
    ciphertext[100] ^= 1
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ciphertext.slice())))
    await expect(fetchDeliveredFile(asset(key), 25 * MiB)).rejects.toThrow('Could not download this file')
  })
})

describe('held delivered files', () => {
  it('reassembles the plaintext from bounded chunks whose MD5 matches the one declared', () => {
    const plaintext = new Uint8Array(randomBytes(5 * DELIVERED_FILE_CHUNK_BYTES + 1234))
    const file = holdDeliveredFile(OWNER, 'book.pdf', plaintext)
    expect(file).toMatchObject({ name: 'book.pdf', size: plaintext.length, md5: md5Hex(plaintext) })
    const { assembled, chunks, largestFrame } = readThroughBridge(file)
    expect(chunks).toBe(6)
    expect(assembled).toEqual(plaintext)
    expect(md5Hex(assembled)).toBe(file.md5)
    // Base64 is 4/3 of the chunk; the envelope adds a few bytes.
    expect(largestFrame).toBeLessThan(DELIVERED_FILE_CHUNK_BYTES * 4 / 3 + 200)
  })

  it('handles a file of exactly whole chunks, and an empty one', () => {
    const whole = new Uint8Array(randomBytes(2 * DELIVERED_FILE_CHUNK_BYTES))
    const file = holdDeliveredFile(OWNER, 'a.bin', whole)
    const first = readDeliveredFileChunk(OWNER, file.handle, 0)
    expect(readDeliveredFileChunk(OWNER, file.handle, first.length)).toEqual(whole.subarray(first.length))
    // The chunk that reached the end released it.
    expect(() => readDeliveredFileChunk(OWNER, file.handle, whole.length)).toThrow('no longer open')

    const empty = holdDeliveredFile(OWNER, 'empty.txt', new Uint8Array(0))
    expect(empty.md5).toBe(md5Hex(new Uint8Array(0)))
    expect(readDeliveredFileChunk(OWNER, empty.handle, 0)).toHaveLength(0)
  })

  it('a chunk md5 catches: a lost or repeated chunk assembles to another digest', () => {
    const plaintext = new Uint8Array(randomBytes(3 * DELIVERED_FILE_CHUNK_BYTES))
    const file = holdDeliveredFile(OWNER, 'book.pdf', plaintext)
    const a = readDeliveredFileChunk(OWNER, file.handle, 0)
    const b = readDeliveredFileChunk(OWNER, file.handle, DELIVERED_FILE_CHUNK_BYTES)
    const repeated = new Uint8Array([...a, ...a, ...b])
    expect(md5Hex(repeated)).not.toBe(file.md5)
    releaseDeliveredFile(file.handle)
  })

  it('reads only for the account that opened it, and drops it for any other', () => {
    const file = holdDeliveredFile(OWNER, 'book.pdf', new Uint8Array(10))
    expect(() => readDeliveredFileChunk('someone-else', file.handle, 0)).toThrow('no longer open')
    expect(() => readDeliveredFileChunk(OWNER, file.handle, 0)).toThrow('no longer open')
  })

  it('refuses an offset outside the file', () => {
    const file = holdDeliveredFile(OWNER, 'book.pdf', new Uint8Array(10))
    expect(() => readDeliveredFileChunk(OWNER, file.handle, 11)).toThrow('out of range')
    expect(() => readDeliveredFileChunk(OWNER, file.handle, -1)).toThrow('out of range')
    expect(() => readDeliveredFileChunk(OWNER, file.handle, 1.5)).toThrow('out of range')
    releaseDeliveredFile(file.handle)
  })

  it('holds at most two files, and lets go of one left unread', () => {
    vi.useFakeTimers()
    const files = [1, 2, 3].map(n => holdDeliveredFile(OWNER, `${n}.bin`, new Uint8Array(10)))
    expect(() => readDeliveredFileChunk(OWNER, files[0].handle, 0)).toThrow('no longer open')
    expect(readDeliveredFileChunk(OWNER, files[1].handle, 0)).toHaveLength(10)
    vi.advanceTimersByTime(2 * 60_000)
    expect(() => readDeliveredFileChunk(OWNER, files[2].handle, 0)).toThrow('no longer open')
  })

  it('measures a 25 MiB file: the largest frame and the time, whole vs chunked', () => {
    const plaintext = new Uint8Array(randomBytes(25 * MiB))

    let started = performance.now()
    // Before: `{ name, base64 }` in one response frame, parsed whole on the host.
    const wholeFrame = stringify({ t: 'res', v: 1, id: '1', ok: true, value: { name: 'big.bin', base64: bytesToBase64(plaintext) } })
    const parsed = parse(wholeFrame) as { value: { base64: string } }
    const wholeMs = performance.now() - started
    expect(parsed.value.base64.length).toBeGreaterThan(plaintext.length)

    started = performance.now()
    const file = holdDeliveredFile(OWNER, 'big.bin', plaintext)
    const { assembled, chunks, largestFrame } = readThroughBridge(file)
    const chunkedMs = performance.now() - started
    expect(md5Hex(assembled)).toBe(file.md5)

    console.info(`[MARCH-1] 25 MiB: whole frame ${(wholeFrame.length / MiB).toFixed(1)} MiB chars in ${wholeMs.toFixed(0)} ms; `
      + `chunked ${chunks} frames, largest ${(largestFrame / 1024).toFixed(0)} KiB chars, ${chunkedMs.toFixed(0)} ms incl. md5`)
    expect(largestFrame * 90).toBeLessThan(wholeFrame.length)
  })
})
