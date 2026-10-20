import { readFileSync } from 'node:fs'
import { brotliCompressSync, constants } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import init, { Identifier } from './web-wasm-sdk'
import { Identifier as SharedIdentifier } from '@dashevo/wasm-sdk'
import { serveFiles } from './test-wasm-fetch'

afterEach(() => vi.unstubAllGlobals())

it('streams the exact published WASM through the WASM brotli decoder into the shared glue and initializes it once', async () => {
  const raw = readFileSync(new URL('../node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm', import.meta.url))
  // A fast brotli level: the stream format is the same as the shipped quality 11.
  const brotli = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
  // A browser without brotli in DecompressionStream (Chromium): the small WASM decoder reads the brotli file.
  const Native = globalThis.DecompressionStream
  vi.stubGlobal('DecompressionStream', class extends Native {
    constructor(format: CompressionFormat) {
      if (String(format) === 'brotli') throw new TypeError('Unsupported compression format')
      super(format)
    }
  })
  vi.stubEnv('NEXT_PUBLIC_SDK_WASM_URL', '/devnet/_next/static/wasm/sdk-test.wasm.gz')
  vi.stubGlobal('window', { __yapprSdkWasm: Promise.resolve(new Response(brotli)) })
  // The decoder's glue fetches its own WASM from a file: URL under Node.
  vi.stubGlobal('fetch', serveFiles())
  const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming')
  try {
    const first = init()
    expect(init()).toBe(first)
    await first
    // Once for the decoder, once for the SDK: both compile while their bytes stream in.
    expect(streaming).toHaveBeenCalledTimes(2)
    expect(Identifier).toBe(SharedIdentifier)
    const bytes = new Uint8Array(32).fill(3)
    expect(new SharedIdentifier(new Identifier(bytes)).toBytes()).toEqual(bytes)
  } finally {
    streaming.mockRestore()
    vi.unstubAllEnvs()
  }
}, 30000)
