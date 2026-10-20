import { readFileSync } from 'node:fs'
import { brotliCompressSync, constants } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brotliDecoderStream } from './brotli-decoder'
import { serveFiles } from './test-wasm-fetch'

/** Feeds `bytes` through the decoder in `size`-byte chunks and returns what came out. */
async function decode(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
      controller.close()
    },
  })
  return new Uint8Array(await new Response(input.pipeThrough(await brotliDecoderStream())).arrayBuffer())
}

// Real data with real structure: the head of the SDK's own WASM, larger than one output chunk.
const sample = readFileSync(new URL('../node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm', import.meta.url)).subarray(0, 3 << 20)
// The shipped window (lgwin 24) needs a 16 MB ring buffer: decode with the real one.
const compressed = brotliCompressSync(sample, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24 } })

beforeEach(() => vi.stubGlobal('fetch', serveFiles()))
afterEach(() => vi.unstubAllGlobals())

describe('WASM brotli decoder', () => {
  it.each([1000, 65536, compressed.length])('decodes a stream fed in %i-byte chunks', async (size) => {
    expect(Buffer.from(await decode(compressed, size)).equals(sample)).toBe(true)
  })

  it('errors on corrupt input', async () => {
    const corrupt = new Uint8Array(compressed)
    corrupt.fill(0xff, 64, 256)
    await expect(decode(corrupt, 4096)).rejects.toThrow()
  })

  it('errors on a truncated stream', async () => {
    await expect(decode(compressed.subarray(0, compressed.length - 100), 4096)).rejects.toThrow('Truncated brotli stream')
  })

  it('errors on data after the end of the stream', async () => {
    const extra = new Uint8Array([...compressed, 1, 2, 3])
    await expect(decode(extra, extra.length)).rejects.toThrow('Unexpected data after the brotli stream')
  })
})
