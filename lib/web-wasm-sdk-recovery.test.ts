import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rawInit } = vi.hoisted(() => ({ rawInit: vi.fn() }))
vi.mock('@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js', () => ({ default: rawInit }))

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

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
})
