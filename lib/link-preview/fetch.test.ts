import { afterEach, describe, expect, it, vi } from 'vitest'
import { canFetchPreview, fetchPreviewContent } from './fetch'

const PREVIOUSLY_FILTERED = 'https://raw.githubusercontent.com/owner/repo/main/removed'

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'

describe('link-preview fetching', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never fetches an ordinary site, through a proxy or directly', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(canFetchPreview('https://news.example/story')).toBe(false)
    await expect(fetchPreviewContent('https://news.example/story')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads IPFS links from its own gateways, never from the host the link names', async () => {
    const fetchMock = vi.fn(async () => new Response('<title>x</title>', { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchPreviewContent(`https://tracker.example/ipfs/${CID}`)
    expect(result.resolvedUrl).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`)
    for (const [requested] of fetchMock.mock.calls as unknown as [string][]) {
      expect(new URL(requested).hostname).not.toBe('tracker.example')
    }
  })

  it('fetches formerly filtered-style links on an allowed host', async () => {
    const fetchMock = vi.fn(async () => new Response('<title>x</title>', { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(canFetchPreview(PREVIOUSLY_FILTERED)).toBe(true)
    await expect(fetchPreviewContent(PREVIOUSLY_FILTERED)).resolves.toMatchObject({ content: '<title>x</title>' })
    expect(fetchMock).toHaveBeenCalledWith(PREVIOUSLY_FILTERED, expect.any(Object))
  })

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'http://i.imgur.com/a', 'https://127.0.0.1/a', 'https://192.168.1.1/a', 'https://localhost/a', 'https://i.imgur.com@127.0.0.1/a', 'https://\\i.imgur.com/a'])('never fetches unsafe or private destinations: %s', async (url) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(canFetchPreview(url)).toBe(false)
    await expect(fetchPreviewContent(url)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the response size limit and image content-type handling', async () => {
    const fetchMock = vi.fn(async () => new Response('large', { headers: { 'content-type': 'text/html', 'content-length': String(5 * 1024 * 1024 + 1) } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPreviewContent('https://i.imgur.com/a')).rejects.toThrow('Content too large')
    fetchMock.mockImplementation(async () => new Response('image bytes', { headers: { 'content-type': 'image/png' } }))
    await expect(fetchPreviewContent('https://i.imgur.com/a')).resolves.toEqual({ content: '', contentType: 'image/png' })
  })

  it('fetches only the allow-listed hosts directly, over https', () => {
    expect(canFetchPreview('https://i.imgur.com/abc')).toBe(true)
    expect(canFetchPreview('http://i.imgur.com/abc')).toBe(false)
    expect(canFetchPreview('https://imgur.com/abc')).toBe(false)
  })
})


const url = 'https://raw.githubusercontent.com/example/preview.html'
const cap = 5 * 1024 * 1024
const encoder = new TextEncoder()
function response(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() },
    cancel,
  })
  return { value: new Response(body, { headers: { 'content-type': 'text/html', ...headers } }), cancel }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('preview resource boundaries (T-SEC-03)', () => {
  it.each<Record<string, string>>([{}, { 'content-length': '12' }])('counts streamed bytes even with missing or misleading length (%j)', async headers => {
    const page = response([new Uint8Array(cap), encoder.encode('<title>too late</title>')], headers)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page.value))
    await expect(fetchPreviewContent(url)).rejects.toThrow('too large')
  })
  it('accepts exactly the cap and decodes split UTF-8', async () => {
    const bytes = encoder.encode('é')
    const page = response([bytes.slice(0, 1), bytes.slice(1), encoder.encode(' '.repeat(cap - 2))])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page.value))
    const result = await fetchPreviewContent(url)
    expect(result.content.startsWith('é')).toBe(true)
    expect(encoder.encode(result.content)).toHaveLength(cap)
  })
  it('cancels a declared oversized body before reading', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html', 'content-length': String(cap + 1) } })))
    await expect(fetchPreviewContent(url)).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['application/octet-stream', 'text/plain', 'application/json', ''])('rejects unsupported metadata type %s and cancels it', async type => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': type } })))
    await expect(fetchPreviewContent(url)).rejects.toThrow('Unsupported')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('cancels image bodies without consuming them', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/png' } })))
    await expect(fetchPreviewContent(url)).resolves.toMatchObject({ content: '', contentType: 'image/png' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('keeps the deadline through a stalled body, even when the source ignores abort', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
      signal = options.signal ?? undefined
      return Promise.resolve(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }))
    }))
    const result = expect(fetchPreviewContent(url)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(8000)
    await result
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('cancels a response arriving after the header deadline even if fetch ignores abort', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let deliver: ((value: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { deliver = resolve })))
    const result = expect(fetchPreviewContent(url)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(8000)
    await result
    deliver?.(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('still refuses unsafe destinations before fetching', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchPreviewContent('https://127.0.0.1/private')).rejects.toThrow('Not fetched')
    expect(fetch).not.toHaveBeenCalled()
  })
})
