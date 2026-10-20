import { describe, expect, it, vi } from 'vitest'
import { sdkWasmBootstrap } from './sdk-wasm-bootstrap'

/** Runs the emitted head script at `pathname` and reports whether it started the download. */
function startsDownload(basePath: string, pathname: string): boolean {
  const fetch = vi.fn().mockResolvedValue(new Response('wasm'))
  const window: { __yapprSdkWasm?: Promise<unknown> } = {}
  const caches = { open: vi.fn().mockRejectedValue(new Error('no storage')) }
  const script = sdkWasmBootstrap(basePath, `${basePath}/_next/static/wasm/sdk-x.wasm.gz`, 'cache')
  new Function('location', 'window', 'caches', 'fetch', script)({ pathname }, window, caches, fetch)
  return window.__yapprSdkWasm !== undefined
}

describe('SDK WASM head bootstrap', () => {
  it.each(['', '/staging'])('starts the download on every data route (base path %j)', (base) => {
    for (const route of ['/', '/feed/', '/explore/', '/hashtag/', '/store/', '/blog/', '/login/', '/user', '/post/']) {
      expect(startsDownload(base, `${base}${route}`), route).toBe(true)
    }
  })

  it.each(['', '/staging'])('skips the static pages, with or without the trailing slash (base path %j)', (base) => {
    for (const route of ['/terms', '/privacy/', '/cookies', '/about/', '/about/private-feeds/']) {
      expect(startsDownload(base, `${base}${route}`), route).toBe(false)
    }
  })

  it('asks for the brotli file on every browser unless it has failed there before', async () => {
    const run = async (brotli: boolean, skipped: string | null = null) => {
      const Native = globalThis.DecompressionStream
      const DS = brotli ? Native : class extends Native {
        constructor(format: CompressionFormat) {
          if (String(format) === 'brotli') throw new TypeError('Unsupported compression format')
          super(format)
        }
      }
      const fetch = vi.fn().mockResolvedValue(new Response('wasm'))
      const window: { __yapprSdkWasm?: Promise<unknown> } = {}
      const script = sdkWasmBootstrap('', '/_next/static/wasm/sdk-x.wasm.gz', 'cache')
      new Function('location', 'window', 'caches', 'fetch', 'DecompressionStream', 'localStorage', script)(
        { pathname: '/feed/' }, window, { open: vi.fn().mockRejectedValue(new Error('no storage')) }, fetch, DS, { getItem: () => skipped },
      )
      await window.__yapprSdkWasm
      return fetch.mock.calls[0][0]
    }
    expect(await run(true)).toBe('/_next/static/wasm/sdk-x.wasm.br')
    // Without brotli in DecompressionStream the app decodes it with a small WASM decoder.
    expect(await run(false)).toBe('/_next/static/wasm/sdk-x.wasm.br')
    expect(await run(false, '/_next/static/wasm/sdk-x.wasm.br')).toBe('/_next/static/wasm/sdk-x.wasm.gz')
  })

  it('escapes markup in what it embeds', () => {
    expect(sdkWasmBootstrap('/x', '/x/</script>.wasm.gz', 'c')).not.toContain('</script>')
  })
})
