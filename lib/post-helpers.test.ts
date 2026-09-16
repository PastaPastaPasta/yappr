import { describe, expect, it } from 'vitest'
import {
  cashtagDisplayToStorage,
  cashtagStorageToDisplay,
  extractAllTags,
  extractCashtags,
  extractHashtags,
  extractMentions,
  firstHashtag,
  firstIndexedTag,
  getTagDisplayText,
  isCashtagStorage,
  normalizeDpnsUsername,
} from './post-helpers'

describe('hashtags', () => {
  it('extracts lowercase, deduplicated tags without the prefix', () => {
    expect(extractHashtags('#Dash and #dash and #Platform!')).toEqual(['dash', 'platform'])
  })

  it('returns the first tag in storage form', () => {
    expect(firstHashtag('hello #Second #first')).toBe('second')
    expect(firstHashtag('no tags here')).toBe('')
  })

  it('truncates the first tag to the contract ceiling', () => {
    const long = 'a'.repeat(70)
    expect(firstHashtag(`#${long}`, 61)).toBe('a'.repeat(61))
    expect(firstHashtag(`#${long}`)).toBe('a'.repeat(63))
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

describe('single inline tag', () => {
  it('indexes the first cashtag when no hashtag exists', () => {
    expect(firstIndexedTag('buy $DASH before $BTC', 61)).toBe('dash_cashtag')
    expect(firstIndexedTag('$1bad then $DaSh_2', 61)).toBe('dash_2_cashtag')
    expect(firstIndexedTag('no tags or $123 here', 61)).toBe('')
  })

  it('preserves the first hashtag precedence regardless of cashtag position', () => {
    expect(firstIndexedTag('$DASH then #Second #first', 61)).toBe('second')
    expect(firstIndexedTag('#First $DASH #second', 61)).toBe('first')
    expect(firstIndexedTag(`#${'a'.repeat(70)} $DASH`, 61)).toBe('a'.repeat(61))
  })

  it.each([61, 63])('fits cashtag storage and links within the %i-character ceiling', (maxLength) => {
    const symbol = 'A'.repeat(63)
    const expected = 'a'.repeat(maxLength - '_cashtag'.length) + '_cashtag'
    expect(firstIndexedTag(`$${symbol}`, maxLength)).toBe(expected)
    expect(cashtagDisplayToStorage(symbol, maxLength)).toBe(expected)
    expect(expected).toHaveLength(maxLength)
  })

  it('retains legacy cashtag conversion when no inline ceiling is passed', () => {
    expect(cashtagDisplayToStorage('A'.repeat(63))).toBe('a'.repeat(63) + '_cashtag')
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
})
