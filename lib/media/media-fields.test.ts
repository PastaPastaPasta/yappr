import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaHashes } from './media-fingerprint'

/** The module reads the topology once, so each one needs a fresh registry. */
async function fieldsOn(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./media-fields')
}

const hashes = (fill: number): MediaHashes => ({ mediaHash: new Uint8Array(32).fill(fill), mediaFingerprint: new Uint8Array(8).fill(fill + 100) })
const ipfs = (n: number) => `ipfs://bafy${n}`

afterEach(() => vi.unstubAllEnvs())

describe('media document fields', () => {
  it('writes v13 media as three parallel arrays: urls, 40-byte digests, kind bytes', async () => {
    const { mediaDocumentFields } = await fieldsOn('v13')
    const fields = mediaDocumentFields([
      { url: ipfs(1), hashes: hashes(1) },
      { url: ipfs(2), hashes: hashes(2), type: 'video' },
      { url: ipfs(3), hashes: hashes(3), type: 'gif' },
    ])
    expect(Object.keys(fields).sort()).toEqual(['mediaDigests', 'mediaKinds', 'mediaUrls'])
    expect(fields.mediaUrls).toEqual([ipfs(1), ipfs(2), ipfs(3)])
    expect(Array.from(fields.mediaKinds as Uint8Array)).toEqual([0, 1, 2])
    const digests = fields.mediaDigests as Uint8Array
    // The `media` rule: count(mediaUrls) × 40 = count(mediaDigests).
    expect(digests.length).toBe(3 * 40)
    expect(Array.from(digests.slice(40, 72))).toEqual(Array(32).fill(2))
    expect(Array.from(digests.slice(72, 80))).toEqual(Array(8).fill(102))
  })

  it('refuses what the v13 contract would: a fifth item, an item without hashes', async () => {
    const { mediaDocumentFields } = await fieldsOn('v13')
    const five = [1, 2, 3, 4, 5].map((n) => ({ url: ipfs(n), hashes: hashes(n) }))
    expect(() => mediaDocumentFields(five)).toThrow(/at most 4/)
    expect(mediaDocumentFields(five.slice(0, 4)).mediaUrls).toHaveLength(4)
    expect(() => mediaDocumentFields([{ url: ipfs(1) }])).toThrow(/content hashes/)
  })

  it('writes nothing for no media, on every cut', async () => {
    for (const topology of ['v2', 'v10', 'v13']) {
      const { mediaDocumentFields } = await fieldsOn(topology)
      expect(mediaDocumentFields([]), topology).toEqual({})
      expect(mediaDocumentFields(undefined), topology).toEqual({})
    }
  })

  it('keeps the single mediaUrl shapes before v13, and one item only', async () => {
    const v12 = await fieldsOn('v12')
    expect(v12.mediaDocumentFields([{ url: ipfs(1), hashes: hashes(1) }])).toEqual({ mediaUrl: ipfs(1), ...hashes(1) })
    expect(() => v12.mediaDocumentFields([{ url: ipfs(1), hashes: hashes(1) }, { url: ipfs(2), hashes: hashes(2) }])).toThrow(/one image/)
    const v2 = await fieldsOn('v2')
    expect(v2.mediaDocumentFields([{ url: 'https://x.test/a.png' }])).toEqual({ mediaUrl: 'https://x.test/a.png' })
  })
})

describe('media read back', () => {
  it('reads every v13 item with its hashes and kind', async () => {
    const { mediaDocumentFields, mediaFromDocument } = await fieldsOn('v13')
    const stored = mediaDocumentFields([{ url: ipfs(1), hashes: hashes(1) }, { url: ipfs(2), hashes: hashes(2), type: 'video' }])
    const media = mediaFromDocument('post', stored, {})
    expect(media?.map((item) => [item.id, item.type, item.url])).toEqual([['post-media-0', 'image', ipfs(1)], ['post-media-1', 'video', ipfs(2)]])
    expect(media?.[1].hashes).toEqual(hashes(2))
  })

  it('ignores a kind byte it does not know (consensus cannot check them): the item shows as an image', async () => {
    const { mediaFromDocument } = await fieldsOn('v13')
    const media = mediaFromDocument('post', { mediaUrls: [ipfs(1)], mediaKinds: new Uint8Array([7]), mediaDigests: new Uint8Array(40) }, {})
    expect(media?.[0].type).toBe('image')
  })

  it('drops digests that do not hold one entry per item, and keeps the media', async () => {
    const { mediaFromDocument } = await fieldsOn('v13')
    const media = mediaFromDocument('post', { mediaUrls: [ipfs(1), ipfs(2)], mediaDigests: new Uint8Array(40), mediaKinds: new Uint8Array(2) }, {})
    expect(media).toHaveLength(2)
    expect(media?.every((item) => item.hashes === undefined)).toBe(true)
  })

  it('reads a tombstone (no media fields) as no media', async () => {
    const { mediaFromDocument } = await fieldsOn('v13')
    expect(mediaFromDocument('post', { deleted: true }, {})).toBeUndefined()
  })

  it('still reads a single mediaUrl', async () => {
    const { mediaFromDocument } = await fieldsOn('v12')
    expect(mediaFromDocument('post', { mediaUrl: ipfs(1), ...hashes(1) }, {})).toEqual([{ id: 'post-media', type: 'image', url: ipfs(1), hashes: hashes(1) }])
  })

  it('names a file\'s kind from its MIME type', async () => {
    const { mediaTypeOfMime } = await fieldsOn('v13')
    expect([mediaTypeOfMime('image/gif'), mediaTypeOfMime('video/mp4'), mediaTypeOfMime('image/png'), mediaTypeOfMime(undefined)]).toEqual(['gif', 'video', 'image', 'image'])
  })
})
