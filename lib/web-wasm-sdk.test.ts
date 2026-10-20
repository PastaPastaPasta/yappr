import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import init, { Identifier } from './web-wasm-sdk'
import { Identifier as SharedIdentifier } from '@dashevo/wasm-sdk'

afterEach(() => vi.unstubAllGlobals())

it('streams the exact published WASM into the shared glue and initializes it once', async () => {
  const raw = readFileSync(new URL('../node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm', import.meta.url))
  // A browser without brotli in DecompressionStream, so the gzip file is the one it asks for.
  const Native = globalThis.DecompressionStream
  vi.stubGlobal('DecompressionStream', class extends Native {
    constructor(format: CompressionFormat) {
      if (String(format) === 'brotli') throw new TypeError('Unsupported compression format')
      super(format)
    }
  })
  vi.stubEnv('NEXT_PUBLIC_SDK_WASM_URL', '/devnet/_next/static/wasm/sdk-test.wasm.gz')
  vi.stubGlobal('window', { __yapprSdkWasm: Promise.resolve(new Response(gzipSync(raw))) })
  const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming')
  try {
    const first = init()
    expect(init()).toBe(first)
    await first
    expect(streaming).toHaveBeenCalledTimes(1)
    expect(Identifier).toBe(SharedIdentifier)
    const bytes = new Uint8Array(32).fill(3)
    expect(new SharedIdentifier(new Identifier(bytes)).toBytes()).toEqual(bytes)
  } finally {
    streaming.mockRestore()
    vi.unstubAllEnvs()
  }
}, 30000)
