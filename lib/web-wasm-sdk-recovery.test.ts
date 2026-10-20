import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serveFiles } from './test-wasm-fetch'

const { rawInit } = vi.hoisted(() => ({ rawInit: vi.fn() }))
vi.mock('@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js', () => ({ default: rawInit }))

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

const BROTLI_URL = '/devnet/_next/static/wasm/sdk-test.wasm.br'
const GZIP_URL = '/devnet/_next/static/wasm/sdk-test.wasm.gz'

/** A browser that remembers the brotli file failing, so it takes the gzip file. */
function gzipOnly() {
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'yappr-sdk-wasm-skip-brotli' ? BROTLI_URL : null), setItem: vi.fn() })
}

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
    gzipOnly()
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
    gzipOnly()
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
    gzipOnly()
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

  it('asks for the brotli file on every browser until it has failed there', async () => {
    const { sdkWasmUrl } = await import('./web-wasm-preload')
    expect(sdkWasmUrl('/x/sdk-a.wasm.gz')).toBe('/x/sdk-a.wasm.br')
    withoutBrotli()
    expect(sdkWasmUrl('/x/sdk-a.wasm.gz')).toBe('/x/sdk-a.wasm.br')
    gzipOnly()
    expect(sdkWasmUrl(GZIP_URL)).toBe(GZIP_URL)
  })

  it('decodes the brotli file with the WASM decoder where DecompressionStream lacks brotli', async () => {
    withoutBrotli()
    const cache = { delete: vi.fn(), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    const fetch = serveFiles({ [BROTLI_URL]: () => new Response(brotliCompressSync(wasm)) })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(fetch.mock.calls.map(([url]) => String(url)).filter(url => !url.startsWith('file:'))).toEqual([BROTLI_URL])
    expect(cache.delete).not.toHaveBeenCalled()
    // The decoded WASM is what is kept, so the next visit needs no decoder.
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1))
    expect(cache.put.mock.calls[0][0]).toBe(BROTLI_URL)
    expect(new Uint8Array(await cache.put.mock.calls[0][1].arrayBuffer())).toEqual(wasm)
  })

  it('takes the decoded WASM kept by an earlier visit without loading the decoder or downloading', async () => {
    withoutBrotli()
    const brotliDecoderStream = vi.fn()
    vi.doMock('./brotli-decoder', () => ({ brotliDecoderStream }))
    const match = vi.fn(async (url: string) => (url === BROTLI_URL ? new Response(wasm) : undefined))
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match, put: vi.fn(), keys: vi.fn().mockResolvedValue([]), delete: vi.fn() }) })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    try {
      const { default: init } = await import('./web-wasm-sdk')
      await expect(init()).resolves.toBe('initialized')
    } finally {
      vi.doUnmock('./brotli-decoder')
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(brotliDecoderStream).not.toHaveBeenCalled()
  })

  it.each([
    { failure: 'cannot be loaded', setup: () => { vi.doMock('./brotli-decoder', () => ({ brotliDecoderStream: () => Promise.reject(new Error('chunk failed')) })) } },
    { failure: 'meets damaged data', setup: () => undefined },
  ])('falls back to the gzip file and remembers it when the WASM decoder $failure', async ({ setup }) => {
    withoutBrotli()
    setup()
    const cache = { delete: vi.fn().mockResolvedValue(true), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    let cancelled = false
    // Still downloading: the stream stays open until something cancels it.
    const damaged = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) },
      cancel() { cancelled = true },
    }))
    const fetch = serveFiles({ [BROTLI_URL]: damaged, [GZIP_URL]: () => new Response(gzipSync(wasm)) })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
    try {
      const { default: init } = await import('./web-wasm-sdk')
      await expect(init()).resolves.toBe('initialized')
    } finally {
      vi.doUnmock('./brotli-decoder')
    }
    expect(fetch.mock.calls.map(([url]) => String(url)).filter(url => !url.startsWith('file:'))).toEqual([BROTLI_URL, GZIP_URL])
    // The abandoned brotli download is stopped rather than left competing with the gzip one.
    expect(cancelled).toBe(true)
    expect(storage.get('yappr-sdk-wasm-skip-brotli')).toBe(BROTLI_URL)
    expect(cache.put).not.toHaveBeenCalledWith(BROTLI_URL, expect.anything())
  })

  it('keeps nothing from a decoded brotli file the SDK rejects, and falls back to gzip', async () => {
    withoutBrotli()
    rawInit.mockRejectedValueOnce(new Error('bad module'))
    const cache = { delete: vi.fn().mockResolvedValue(true), put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined), keys: vi.fn().mockResolvedValue([]) }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    vi.stubGlobal('fetch', serveFiles({ [BROTLI_URL]: () => new Response(brotliCompressSync(wasm)), [GZIP_URL]: () => new Response(gzipSync(wasm)) }))
    vi.stubGlobal('window', {})
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
    const { default: init } = await import('./web-wasm-sdk')
    await expect(init()).resolves.toBe('initialized')
    expect(rawInit).toHaveBeenCalledTimes(2)
    expect(storage.get('yappr-sdk-wasm-skip-brotli')).toBe(BROTLI_URL)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1))
    expect(cache.put.mock.calls[0][0]).toBe(GZIP_URL)
  })

  it('never loads the WASM decoder where DecompressionStream reads brotli', async () => {
    const brotliDecoderStream = vi.fn()
    vi.doMock('./brotli-decoder', () => ({ brotliDecoderStream }))
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('fetch', serveFiles({ [BROTLI_URL]: () => new Response(brotliCompressSync(wasm)) }))
    vi.stubGlobal('window', {})
    try {
      const { default: init } = await import('./web-wasm-sdk')
      await expect(init()).resolves.toBe('initialized')
    } finally {
      vi.doUnmock('./brotli-decoder')
    }
    expect(brotliDecoderStream).not.toHaveBeenCalled()
  })
})
