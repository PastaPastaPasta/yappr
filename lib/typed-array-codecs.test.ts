import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import {
  decodeBlockFollowIds, decodeLabelList, decodePaymentUriList, decodeSocialLinkList, decodeStringList,
  encodeBlockFollowIds, encodeLabelList, encodePaymentUriList, encodeSocialLinkList, encodeStringList,
  socialLinkFromString, uniqueStrings,
} from './typed-array-codecs'

const idA = bs58.encode(new Uint8Array(32).fill(1))
const idB = bs58.encode(new Uint8Array(32).fill(2))

describe('typed-array codecs', () => {
  describe('blockFollow.followedBlockers', () => {
    it('encodes packed bytes for v2–v8 and a list of ids for v9', () => {
      const packed = encodeBlockFollowIds([idA, idB], false) as Uint8Array
      expect(packed).toBeInstanceOf(Uint8Array)
      expect(packed.length).toBe(64)
      const list = encodeBlockFollowIds([idA, idB], true) as Uint8Array[]
      expect(list.map((id) => bs58.encode(id))).toEqual([idA, idB])
    })

    it('decodes both shapes back to the same ids', () => {
      expect(decodeBlockFollowIds(encodeBlockFollowIds([idA, idB], false))).toEqual([idA, idB])
      expect(decodeBlockFollowIds(encodeBlockFollowIds([idA, idB], true))).toEqual([idA, idB])
      // v9 JSON reads hand identifier elements back as base58 strings.
      expect(decodeBlockFollowIds([idA, idB])).toEqual([idA, idB])
      // A legacy byte array handed back as number[] is still packed bytes.
      expect(decodeBlockFollowIds(Array.from(new Uint8Array(64).fill(1)))).toEqual([idA, idA])
      expect(decodeBlockFollowIds(undefined)).toEqual([])
    })
  })

  describe('profile paymentUris / socialLinks', () => {
    it('round-trips payment URIs through both encodings', () => {
      const uris = ['dash:Xabc', 'bitcoin:bc1q']
      expect(encodePaymentUriList(uris, false)).toBe('["dash:Xabc","bitcoin:bc1q"]')
      expect(encodePaymentUriList(uris, true)).toEqual(uris)
      expect(decodePaymentUriList('["dash:Xabc","bitcoin:bc1q"]')).toEqual(uris)
      expect(decodePaymentUriList(uris)).toEqual(uris)
      expect(decodePaymentUriList('not json')).toEqual([])
    })

    it('stores a social link as "platform:handle", splitting on the FIRST colon only', () => {
      const links = [{ platform: 'twitter', handle: '@alice' }, { platform: 'other', handle: 'https://example.com/a:b' }]
      expect(encodeSocialLinkList(links, true)).toEqual(['twitter:@alice', 'other:https://example.com/a:b'])
      expect(decodeSocialLinkList(['twitter:@alice', 'other:https://example.com/a:b'])).toEqual(links)
      expect(socialLinkFromString('mastodon:@user@host.social')).toEqual({ platform: 'mastodon', handle: '@user@host.social' })
      expect(socialLinkFromString('nocolon')).toBeNull()
      expect(socialLinkFromString(':empty-platform')).toBeNull()
      expect(socialLinkFromString('empty-handle:')).toBeNull()
    })

    it('still reads the v1 JSON of objects', () => {
      const links = [{ platform: 'github', handle: 'alice' }]
      expect(encodeSocialLinkList(links, false)).toBe(JSON.stringify(links))
      expect(decodeSocialLinkList(JSON.stringify(links))).toEqual(links)
      expect(decodeSocialLinkList('[{"platform":1}]')).toEqual([])
    })
  })

  describe('blog labels', () => {
    it('writes a comma-separated string before v4 and a list from v4, omitting none', () => {
      expect(encodeLabelList([' oncall', 'databases', 'oncall'], false)).toBe('oncall,databases')
      expect(encodeLabelList(['oncall', 'databases'], true)).toEqual(['oncall', 'databases'])
      expect(encodeLabelList([], true)).toBeUndefined()
      expect(encodeLabelList(['  '], false)).toBeUndefined()
    })

    it('reads either shape', () => {
      expect(decodeLabelList('oncall, databases,,oncall')).toEqual(['oncall', 'databases'])
      expect(decodeLabelList(['oncall', 'databases'])).toEqual(['oncall', 'databases'])
      expect(decodeLabelList(undefined)).toEqual([])
    })
  })

  describe('storefront tags / imageUrls', () => {
    it('writes JSON before v4 and a list from v4, and reads either', () => {
      expect(encodeStringList(['wood', 'wood', 'catan'], false)).toBe('["wood","catan"]')
      expect(encodeStringList(['wood', 'catan'], true)).toEqual(['wood', 'catan'])
      expect(encodeStringList([], true)).toBeUndefined()
      expect(decodeStringList('["wood","catan"]')).toEqual(['wood', 'catan'])
      expect(decodeStringList(['wood', 'catan'])).toEqual(['wood', 'catan'])
    })
  })

  it('uniqueStrings trims, drops empties and keeps first occurrences', () => {
    expect(uniqueStrings([' a', 'b', 'a', '', 'b '])).toEqual(['a', 'b'])
  })
})

describe('list limits (beta.4 schema bounds)', () => {
  it('accepts lists within bounds and names the first breach', async () => {
    const { LIST_LIMITS, ListLimitError, assertListLimits, listLimitProblem } = await import('./typed-array-codecs')
    expect(listLimitProblem(['a', 'b'], LIST_LIMITS.postLabels)).toBeNull()
    expect(listLimitProblem(Array.from({ length: 17 }, (_, i) => `l${i}`), LIST_LIMITS.postLabels)).toMatch(/At most 16 post labels/)
    expect(listLimitProblem(['x'.repeat(41)], LIST_LIMITS.blogLabels)).toMatch(/at most 40 characters/)
    expect(listLimitProblem(['https://a.png', 'ipfs://bafy'], LIST_LIMITS.storeImageUrls)).toBeNull()
    expect(listLimitProblem(['ftp://a.png'], LIST_LIMITS.storeImageUrls)).toMatch(/https:\/\//)
    expect(() => assertListLimits(['x'.repeat(65)], LIST_LIMITS.storeTags)).toThrow(ListLimitError)
  })
})
