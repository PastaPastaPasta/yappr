import { afterEach, describe, expect, it, vi } from 'vitest'
import { canFetchPreview, fetchPreviewContent } from './fetch'

const DENIED = 'https://raw.githubusercontent.com/owner/repo/main/removed'

vi.mock('@/lib/media/media-denylist.json', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: {
      cids: [],
      urlSha256: [{ sha256: createHash('sha256').update('https://raw.githubusercontent.com/owner/repo/main/removed').digest('hex'), added: '2026-10-17', ref: 'TEST' }],
    },
  }
})

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

  it('never requests a denylisted link, even on an allow-listed host', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(canFetchPreview(DENIED)).toBe(false)
    await expect(fetchPreviewContent(DENIED)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(canFetchPreview('https://raw.githubusercontent.com/owner/repo/main/kept')).toBe(true)
  })

  it('fetches only the allow-listed hosts directly, over https', () => {
    expect(canFetchPreview('https://i.imgur.com/abc')).toBe(true)
    expect(canFetchPreview('http://i.imgur.com/abc')).toBe(false)
    expect(canFetchPreview('https://imgur.com/abc')).toBe(false)
  })
})
