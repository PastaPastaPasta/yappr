import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rawInit } = vi.hoisted(() => ({ rawInit: vi.fn() }))
vi.mock('@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js', () => ({ default: rawInit }))

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

/** A browser whose DecompressionStream reads gzip but not brotli (Chromium). */
function withoutBrotli() {
  const Native = globalThis.DecompressionStream
  vi.stubGlobal('DecompressionStream', class extends Native {
    constructor(format: CompressionFormat) {
      if (String(format) === 'brotli') throw new TypeError('Unsupported compression format')
      super(format)
    }
  })
}

beforeEach(() => {
  vi.resetModules()
  rawInit.mockReset()
  rawInit.mockImplementation(async ({ module_or_path }: { module_or_path: Response }) => {
    expect(module_or_path.headers.get('Content-Type')).toBe('application/wasm')
    await WebAssembly.compile(await module_or_path.arrayBuffer())
    return 'initialized'
  })
  vi.stubEnv('NEXT_PUBLIC_SDK_WASM_URL', '/devnet/_next/static/wasm/sdk-test.wasm.gz')
  vi.stubGlobal('location', { href: 'https://yap.pr/devnet/feed/' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('web WASM recovery', () => {
  it('evicts damaged bytes and recovers with one fresh download', async () => {
    withoutBrotli()
    vi.stubGlobal('window', { __yapprSdkWasm: Promise.resolve(new Response('damaged')) })
    const remove = vi.fn().mockResolvedValue(true)
    const put = vi.fn().mockResolvedValue(undefined)
    const cache = { delete: remove, put, match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = vi.fn().mockResolvedValue(new Response(gzipSync(wasm)))
    vi.stubGlobal('fetch', fetch)
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/devnet/_next/static/wasm/sdk-test.wasm.gz', { cache: 'reload' })
    expect(rawInit).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(new Uint8Array(await put.mock.calls[0][1].arrayBuffer())).toEqual(new Uint8Array(gzipSync(wasm)))
  })

  it('accepts HTTP-decoded WASM and reads a split gzip header without losing bytes', async () => {
    withoutBrotli()
    for (const bytes of [wasm, gzipSync(wasm)]) {
      vi.resetModules()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1))
          controller.enqueue(bytes.slice(1))
          controller.close()
        },
      })
      vi.stubGlobal('window', { __yapprSdkWasm: Promise.resolve(new Response(body)) })
      const { default: init } = await import('./web-wasm-sdk')
      await expect(init()).resolves.toBe('initialized')
    }
  })

  it('publishes the fallback download so the parser cannot start another one', async () => {
    withoutBrotli()
    const window = {}
    vi.stubGlobal('window', window)
    vi.stubGlobal('caches', undefined)
    const fetch = vi.fn().mockResolvedValue(new Response(gzipSync(wasm)))
    vi.stubGlobal('fetch', fetch)
    const { default: init } = await import('./web-wasm-sdk')
    const first = init()
    expect(window).toHaveProperty('__yapprSdkWasm')
    expect(init()).toBe(first)
    await expect(first).resolves.toBe('initialized')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds retries even when both storage and the network are unavailable', async () => {
    vi.stubGlobal('window', { __yapprSdkWasm: Promise.resolve(undefined) })
    vi.stubGlobal('caches', undefined)
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const { default: init } = await import('./web-wasm-sdk')
    const first = init()
    await expect(first).rejects.toThrow('Couldn’t load Yappr')
    expect(init()).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('downloads and decodes the brotli file where the browser can decompress brotli', async () => {
    const remove = vi.fn().mockResolvedValue(true)
    const put = vi.fn().mockResolvedValue(undefined)
    const cache = { delete: remove, put, match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = vi.fn().mockResolvedValue(new Response(brotliCompressSync(wasm)))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/devnet/_next/static/wasm/sdk-test.wasm.br', { cache: 'force-cache' })
    expect(remove).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put.mock.calls[0][0]).toBe('/devnet/_next/static/wasm/sdk-test.wasm.br')
  })

  it('falls back to the gzip file when the brotli file cannot be loaded', async () => {
    const cache = { delete: vi.fn().mockResolvedValue(true), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(gzipSync(wasm)))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(fetch.mock.calls).toEqual([
      ['/devnet/_next/static/wasm/sdk-test.wasm.br', { cache: 'force-cache' }],
      ['/devnet/_next/static/wasm/sdk-test.wasm.gz', { cache: 'force-cache' }],
    ])
    // Later visits go straight to the gzip file.
    expect(storage.get('yappr-sdk-wasm-skip-brotli')).toBe('/devnet/_next/static/wasm/sdk-test.wasm.br')
    const { sdkWasmUrl } = await import('./web-wasm-preload')
    expect(sdkWasmUrl('/devnet/_next/static/wasm/sdk-test.wasm.gz')).toBe('/devnet/_next/static/wasm/sdk-test.wasm.gz')
  })

  it('decodes the brotli file as brotli even when it begins with the gzip magic bytes', async () => {
    const brotli = new Uint8Array([0x1f, 0x8b, 9, 9])
    const decoded: string[] = []
    const Native = globalThis.DecompressionStream
    vi.stubGlobal('DecompressionStream', class extends Native {
      constructor(format: CompressionFormat) {
        decoded.push(String(format))
        // The brotli decoder is stood in for by an identity transform yielding the WASM.
        if (String(format) === 'brotli') {
          super('deflate-raw')
          return new TransformStream({ transform: (_chunk, controller) => controller.enqueue(wasm) }) as unknown as DecompressionStream
        }
        super(format)
      }
    })
    const cache = { delete: vi.fn(), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = vi.fn().mockResolvedValue(new Response(brotli))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(decoded).toContain('brotli')
    expect(decoded).not.toContain('gzip')
  })

  it('falls back to the gzip file when the brotli file arrives damaged', async () => {
    const cache = { delete: vi.fn().mockResolvedValue(true), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([0x8b, 1, 2, 3, 4, 5])))
      .mockResolvedValueOnce(new Response(gzipSync(wasm)))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cache.delete).toHaveBeenCalledWith('/devnet/_next/static/wasm/sdk-test.wasm.br')
  })

  it('asks for the gzip file where the browser cannot decompress brotli', async () => {
    withoutBrotli()
    const { sdkWasmUrl } = await import('./web-wasm-preload')
    expect(sdkWasmUrl('/x/sdk-a.wasm.gz')).toBe('/x/sdk-a.wasm.gz')
    vi.unstubAllGlobals()
    expect(sdkWasmUrl('/x/sdk-a.wasm.gz')).toBe('/x/sdk-a.wasm.br')
  })
})
