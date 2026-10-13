import { describe, expect, it } from 'vitest'
import {
  cashtagDisplayToStorage,
  cashtagStorageToDisplay,
  extractAllTags,
  extractCashtags,
  extractHashtags,
  extractMentions,
  getTagDisplayText,
  hashtagDisplayToStorage,
  indexedTags,
  isCashtagStorage,
  normalizeDpnsUsername,
} from './post-helpers'

describe('hashtags', () => {
  it('extracts lowercase, deduplicated tags without the prefix', () => {
    expect(extractHashtags('#Dash and #dash and #Platform!')).toEqual(['dash', 'platform'])
  })

  it('returns the first tag in storage form', () => {
    expect(indexedTags('hello #Second #first', 1, 61)).toEqual(['second'])
    expect(indexedTags('no tags here', 1, 61)).toEqual([])
  })

  it('truncates the first tag to the contract ceiling', () => {
    const long = 'a'.repeat(70)
    expect(indexedTags(`#${long}`, 1, 61)).toEqual(['a'.repeat(61)])
  })

  it('links an over-long tag to the page it was indexed under (QA D-21)', () => {
    const content = `#${'B'.repeat(62)}`
    expect([hashtagDisplayToStorage(`#${'B'.repeat(62)}`, 61)]).toEqual(indexedTags(content, 1, 61))
    expect(hashtagDisplayToStorage('#Dash')).toBe('dash')
    expect(hashtagDisplayToStorage('#Dash', 61)).toBe('dash')
  })
})

describe('cashtags', () => {
  it('stores cashtags with a suffix so they share the hashtag index', () => {
    expect(extractCashtags('buy $DASH not $dash or $1bad')).toEqual(['dash_cashtag'])
    expect(isCashtagStorage('dash_cashtag')).toBe(true)
    expect(isCashtagStorage('dash')).toBe(false)
  })

  it('converts between display and storage forms', () => {
    expect(cashtagDisplayToStorage('$DASH')).toBe('dash_cashtag')
    expect(cashtagDisplayToStorage('Dash')).toBe('dash_cashtag')
    expect(cashtagStorageToDisplay('dash_cashtag')).toBe('DASH')
    expect(cashtagStorageToDisplay('dash')).toBe('dash')
    expect(getTagDisplayText('dash_cashtag')).toBe('$DASH')
    expect(getTagDisplayText('dash')).toBe('#dash')
  })

  it('merges hashtags and cashtags into one tag list', () => {
    expect(extractAllTags('#dash $DASH #dash')).toEqual(['dash', 'dash_cashtag'])
  })
})

describe('single inline tag (v9 to v15)', () => {
  it('indexes the first cashtag when no hashtag exists', () => {
    expect(indexedTags('buy $DASH before $BTC', 1, 61)).toEqual(['dash_cashtag'])
    expect(indexedTags('$1bad then $DaSh_2', 1, 61)).toEqual(['dash_2_cashtag'])
    expect(indexedTags('no tags or $123 here', 1, 61)).toEqual([])
  })

  it('preserves the first hashtag precedence regardless of cashtag position', () => {
    expect(indexedTags('$DASH then #Second #first', 1, 61)).toEqual(['second'])
    expect(indexedTags('#First $DASH #second', 1, 61)).toEqual(['first'])
    expect(indexedTags(`#${'a'.repeat(70)} $DASH`, 1, 61)).toEqual(['a'.repeat(61)])
  })

  it.each([61, 63])('fits cashtag storage and links within the %i-character ceiling', (maxLength) => {
    const symbol = 'A'.repeat(63)
    const expected = 'a'.repeat(maxLength - '_cashtag'.length) + '_cashtag'
    expect(indexedTags(`$${symbol}`, 1, maxLength)).toEqual([expected])
    expect(cashtagDisplayToStorage(symbol, maxLength)).toBe(expected)
    expect(expected).toHaveLength(maxLength)
  })

  it('retains legacy cashtag conversion when no inline ceiling is passed', () => {
    expect(cashtagDisplayToStorage('A'.repeat(63))).toBe('a'.repeat(63) + '_cashtag')
  })
})

describe('tag list (v16)', () => {
  it('indexes the hashtags in order, then the cashtags, distinct, up to the maximum', () => {
    expect(indexedTags('$DASH #News then #dash and #news, $btc', 4, 61)).toEqual(['news', 'dash', 'dash_cashtag', 'btc_cashtag'])
    expect(indexedTags('#a #b #c #d #e $DASH', 4, 61)).toEqual(['a', 'b', 'c', 'd'])
    expect(indexedTags('#a $DASH', 4, 61)).toEqual(['a', 'dash_cashtag'])
    expect(indexedTags('nothing to index, $1bad', 4, 61)).toEqual([])
  })

  it('truncates each tag to the ceiling and counts a truncated duplicate once', () => {
    const long = 'a'.repeat(70)
    expect(indexedTags(`#${long} #${'a'.repeat(61)} #b`, 4, 61)).toEqual(['a'.repeat(61), 'b'])
  })
})

describe('mentions', () => {
  it('normalizes DPNS usernames', () => {
    expect(normalizeDpnsUsername('Pasta.dash')).toBe('pasta')
    expect(normalizeDpnsUsername('PASTA')).toBe('pasta')
  })

  it('extracts deduplicated mentions with or without .dash', () => {
    expect(extractMentions('hi @Alice.dash and @alice, cc @bob_2')).toEqual(['alice', 'bob_2'])
    expect(extractMentions('email me at foo@bar.com')).toEqual(['bar'])
  })

  it('keeps hyphenated DPNS mentions intact for indexing and deduplication', () => {
    expect(extractMentions('Hello @ingrid-vinyl9 and @Ingrid-Vinyl9.dash!'))
      .toEqual(['ingrid-vinyl9'])
    expect(extractMentions('cc @qa-multi-part-42.dash, @hamzak78, and @another-name'))
      .toEqual(['qa-multi-part-42', 'hamzak78', 'another-name'])
  })

  it('lists mentions in order of first appearance, the order they are indexed in', () => {
    expect(extractMentions('cc @Bob.dash then @alice and @bob')).toEqual(['bob', 'alice'])
    expect(extractMentions('no mentions here')).toEqual([])
  })
})
