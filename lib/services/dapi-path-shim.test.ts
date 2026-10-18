import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAPI_REQUEST_TIMEOUT_MS, installDapiPathShim, rewriteDapiUrl } from './dapi-path-shim'

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

  it('covers discovered testnet nodes without an explicit address list', () => {
    expect(rewriteDapiUrl(`https://68.67.122.225:1443//${METHOD}`, new Set())).toBe(`https://68.67.122.225:1443/${METHOD}`)
  })

  it('covers discovered mainnet nodes on the default HTTPS port', () => {
    expect(rewriteDapiUrl(`https://mainnet.example:443//${METHOD}`, new Set())).toBe(`https://mainnet.example/${METHOD}`)
  })

  it('leaves other protocols and ports alone', () => {
    expect(rewriteDapiUrl(`https://68.67.122.224:8443//${METHOD}`, ORIGINS)).toBeNull()
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
    vi.useFakeTimers()
    calls = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init, request: input instanceof Request ? input : undefined })
      return new Response('ok')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
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
    expect(calls[0].init?.method).toBe('POST')
    const signal = calls[0].init?.signal
    expect(signal?.aborted).toBe(false)
    controller.abort()
    expect(signal?.aborted).toBe(true)
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

  it('installs without configured addresses for networks using discovery', async () => {
    installDapiPathShim()
    await fetch(`https://68.67.122.225:1443//${METHOD}`)
    expect(calls[0].url).toBe(`https://68.67.122.225:1443/${METHOD}`)
  })

  it.each(['/', '//'])('aborts a stalled discovered DAPI fetch on the %s path at the deadline', async (slash) => {
    globalThis.fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as typeof fetch
    installDapiPathShim()
    const read = fetch(`https://68.67.122.24:1443${slash}${METHOD}`)
    const failed = expect(read).rejects.toThrow('DAPI request timed out')
    await vi.advanceTimersByTimeAsync(DAPI_REQUEST_TIMEOUT_MS)
    await failed
  })

  it('keeps the deadline active after headers arrive, until the response body is read', async () => {
    globalThis.fetch = vi.fn(async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
      },
    }))) as typeof fetch
    installDapiPathShim()
    const response = await fetch(`${NODE}/${METHOD}`)
    const failed = expect(response.arrayBuffer()).rejects.toThrow('DAPI request timed out')
    await vi.advanceTimersByTimeAsync(DAPI_REQUEST_TIMEOUT_MS)
    await failed
  })

  it('preserves Request cancellation and leaves non-DAPI fetch signals unchanged', async () => {
    installDapiPathShim()
    const caller = new AbortController()
    await fetch(new Request(`${NODE}/${METHOD}`, { signal: caller.signal }))
    const combined = calls[0].init?.signal
    caller.abort()
    expect(combined?.aborted).toBe(true)
    await fetch('https://quorums.testnet.networks.dash.org/quorums', { signal: caller.signal })
    expect(calls[1].init?.signal).toBe(caller.signal)
  })

  it.each([['300S', 300_000], ['8000000u', 8_000], ['1n', 1], ['invalid', 8_000]])('honors grpc-timeout %s, including long confirmation streams', async (header, ms) => {
    installDapiPathShim()
    await fetch(new Request(`${NODE}/${METHOD}`, { headers: { 'grpc-timeout': header } }))
    const signal = calls[0].init?.signal
    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
  })

  it('keeps an already cancelled request cancelled', async () => {
    const caller = new AbortController()
    caller.abort(new Error('cancelled'))
    installDapiPathShim()
    await fetch(`${NODE}/${METHOD}`, { signal: caller.signal })
    expect(calls[0].init?.signal?.aborted).toBe(true)
    expect(calls[0].init?.signal?.reason).toBe(caller.signal.reason)
  })

  it('enforces the deadline when mobile WebViews lack AbortSignal.timeout and any', async () => {
    vi.stubGlobal('AbortSignal', {})
    installDapiPathShim()
    await fetch(`${NODE}/${METHOD}`)
    const signal = calls[0].init?.signal
    await vi.advanceTimersByTimeAsync(DAPI_REQUEST_TIMEOUT_MS)
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason.name).toBe('TimeoutError')
  })
})
