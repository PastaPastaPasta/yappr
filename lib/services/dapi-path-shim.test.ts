import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDapiPathShim, rewriteDapiUrl } from './dapi-path-shim'

const NODE = 'https://68.67.122.224:1443'
const ORIGINS = new Set([NODE])
const METHOD = 'org.dash.platform.dapi.v0.Platform/getStatus'

describe('rewriteDapiUrl', () => {
  it('collapses the doubled slash the wasm transport sends to a configured node', () => {
    expect(rewriteDapiUrl(`${NODE}//${METHOD}`, ORIGINS)).toBe(`${NODE}/${METHOD}`)
  })

  it('keeps a query string', () => {
    expect(rewriteDapiUrl(`${NODE}//${METHOD}?x=1`, ORIGINS)).toBe(`${NODE}/${METHOD}?x=1`)
  })

  it('leaves a well-formed path alone', () => {
    expect(rewriteDapiUrl(`${NODE}/${METHOD}`, ORIGINS)).toBeNull()
  })

  it('leaves other hosts alone, even with the same doubled path', () => {
    expect(rewriteDapiUrl(`https://68.67.122.225:1443//${METHOD}`, ORIGINS)).toBeNull()
    expect(rewriteDapiUrl(`https://68.67.122.224:443//${METHOD}`, ORIGINS)).toBeNull()
    expect(rewriteDapiUrl(`http://68.67.122.224:1443//${METHOD}`, ORIGINS)).toBeNull()
  })

  it('leaves other double-slash paths on a node alone', () => {
    expect(rewriteDapiUrl(`${NODE}//quorums`, ORIGINS)).toBeNull()
    expect(rewriteDapiUrl(`${NODE}//org.example.Other/method`, ORIGINS)).toBeNull()
  })

  it('does not throw on something that is not a URL', () => {
    expect(rewriteDapiUrl('not a url', ORIGINS)).toBeNull()
  })

  it('matches a hostname address by its origin', () => {
    const seed = 'https://seed-1.moutai.networks.dash.org:1443'
    expect(rewriteDapiUrl(`${seed}//${METHOD}`, new Set([seed]))).toBe(`${seed}/${METHOD}`)
  })
})

describe('installDapiPathShim', () => {
  const realFetch = globalThis.fetch
  let calls: Array<{ url: string; init?: RequestInit; request?: Request }>
  // The Request the wrapper handed on; a rewrite always passes one for a Request input.
  const sentRequest = (index = 0): Request => {
    const request = calls[index]?.request
    if (!request) throw new Error(`call ${index} did not pass a Request`)
    return request
  }

  beforeEach(() => {
    calls = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init, request: input instanceof Request ? input : undefined })
      return new Response('ok')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('rewrites a Request to a configured node and keeps its method, headers and body', async () => {
    installDapiPathShim([NODE])
    const body = new Uint8Array([0, 0, 0, 0, 1, 7])
    const request = new Request(`${NODE}//${METHOD}`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto' },
      body,
    })
    const controller = new AbortController()
    await fetch(request, { method: 'POST', signal: controller.signal })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${NODE}/${METHOD}`)
    expect(calls[0].init).toEqual({ method: 'POST', signal: controller.signal })
    const sent = sentRequest()
    expect(sent.method).toBe('POST')
    expect(sent.headers.get('content-type')).toBe('application/grpc-web+proto')
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(body)
  })

  it('never reads the body off Request.body, which Firefox and Safari lack', async () => {
    installDapiPathShim([NODE])
    const body = new Uint8Array([0, 0, 0, 0, 2, 9, 9])
    const request = new Request(`${NODE}//${METHOD}`, { method: 'POST', body })
    // What Firefox exposes: no `body` stream on a Request.
    Object.defineProperty(request, 'body', { value: undefined })
    await fetch(request)
    expect(new Uint8Array(await sentRequest().arrayBuffer())).toEqual(body)
  })

  it('forwards anything else unchanged', async () => {
    installDapiPathShim([NODE])
    await fetch('https://quorums.bonsia.networks.dash.org/quorums')
    await fetch(`${NODE}/${METHOD}`)
    expect(calls.map((call) => call.url)).toEqual([
      'https://quorums.bonsia.networks.dash.org/quorums',
      `${NODE}/${METHOD}`,
    ])
  })

  it('wraps once, and a later install adds its origins to the same wrapper', async () => {
    installDapiPathShim([NODE])
    const first = globalThis.fetch
    installDapiPathShim([NODE, 'https://68.67.122.242:1443'])
    expect(globalThis.fetch).toBe(first)
    await fetch(`https://68.67.122.242:1443//${METHOD}`)
    expect(calls[0].url).toBe(`https://68.67.122.242:1443/${METHOD}`)
  })

  it('does nothing without a usable address', () => {
    const before = globalThis.fetch
    installDapiPathShim(['', 'not a url'])
    expect(globalThis.fetch).toBe(before)
  })
})
