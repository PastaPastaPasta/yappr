import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadSdkWasm, storeSdkWasm } from './web-wasm-preload'

// Exercise the serialized bootstrap too: it must have no module-scope helpers.
const preload: typeof preloadSdkWasm = new Function(`return (${preloadSdkWasm.toString()})`)()

afterEach(() => vi.unstubAllGlobals())

describe('versioned SDK download', () => {
  const url = 'https://yap.pr/devnet/_next/static/wasm/sdk-version.wasm.gz'
  const cacheName = 'yappr-sdk-wasm:/devnet'

  it('reuses persistent bytes without a network request', async () => {
    const response = new Response('cached')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(response) }) })
    expect(await preload(url, cacheName)).toBe(response)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to HTTP caching when storage is unavailable', async () => {
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('storage blocked')) })
    const response = new Response('download')
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    expect(await preload(url, cacheName)).toBe(response)
    expect(fetch).toHaveBeenCalledWith(url, { cache: 'force-cache' })
  })

  it('does not store the speculative download and prunes old versions only after the verified bytes are stored', async () => {
    let finishWrite: () => void = () => { throw new Error('write was not started') }
    const write = new Promise<void>(resolve => { finishWrite = resolve })
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockReturnValue(write),
      keys: vi.fn().mockResolvedValue([new Request(url), new Request(url.replace('version', 'old'))]),
      delete: vi.fn().mockResolvedValue(true),
    }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    vi.stubGlobal('location', { href: url })
    const response = new Response('download')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    expect(await preload(url, cacheName)).toBe(response)
    expect(cache.put).not.toHaveBeenCalled()
    const stored = storeSdkWasm(url, cacheName, response.clone())
    expect(cache.delete).not.toHaveBeenCalled()
    finishWrite()
    await stored
    expect(cache.delete).toHaveBeenCalledTimes(1)
    expect(cache.delete.mock.calls[0][0].url).toContain('sdk-old')
    expect(await response.text()).toBe('download')
  })

  it('does not store failed downloads or surface an unhandled speculative failure', async () => {
    const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() }
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))
    expect(await preload(url, cacheName)).toBeUndefined()
    expect(cache.put).not.toHaveBeenCalled()
  })
})
