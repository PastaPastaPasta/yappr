import { sha256 } from '@noble/hashes/sha2.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkServedMedia, type MediaHashes } from './media-fingerprint'

const IMAGE = new Uint8Array([1, 2, 3, 4])
const posted: MediaHashes = { mediaHash: sha256(IMAGE), mediaFingerprint: new Uint8Array(8) }

function stubFetch(...responses: Array<() => Response>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return next()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const served = () => new Response(IMAGE)
const unavailable = () => new Response(null, { status: 502 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('checkServedMedia caching', () => {
  it('shares one fetch between concurrent and recent checks of the same URL', async () => {
    const fetchMock = stubFetch(served)
    const url = 'https://gateway.test/same'
    const [first, second] = await Promise.all([checkServedMedia(url, posted), checkServedMedia(url, posted)])
    expect([first, second]).toEqual([false, false])
    expect(await checkServedMedia(url, posted)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once a completed verdict is older than its freshness window', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(served, served)
    const url = 'https://gateway.test/expires'
    expect(await checkServedMedia(url, posted)).toBe(false)
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(await checkServedMedia(url, posted)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect(await checkServedMedia(url, posted)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not keep a check that could not run, so the next load retries', async () => {
    const fetchMock = stubFetch(unavailable, served)
    const url = 'https://gateway.test/retry'
    expect(await checkServedMedia(url, posted)).toBeNull()
    expect(await checkServedMedia(url, posted)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
