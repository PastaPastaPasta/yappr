import { describe, expect, it } from 'vitest'
import {
  CASHTAG_PATTERN,
  HASHTAG_PATTERN,
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
  tagStorage,
} from './post-helpers'

describe('hashtags', () => {
  it('extracts lowercase, deduplicated tags without the prefix', () => {
    expect(extractHashtags('#Dash and #dash and #Platform!', 63)).toEqual(['dash', 'platform'])
  })

  it('returns the first tag in storage form', () => {
    expect(indexedTags('hello #Second #first', 1, 61)).toEqual(['second'])
    expect(indexedTags('no tags here', 1, 61)).toEqual([])
  })

  it('converts a display hashtag to storage form', () => {
    expect(hashtagDisplayToStorage('#Dash')).toBe('dash')
    expect(hashtagDisplayToStorage('Dash')).toBe('dash')
  })
})

describe('tag boundaries (D7: a tag is a whole ASCII word)', () => {
  const tags = (content: string) => indexedTags(content, Number.MAX_SAFE_INTEGER, 61)

  it.each([
    ['#café', 'accented letter'],
    ['#naïve', 'diaeresis mid-word'],
    ['#straße', 'sharp s'],
    ['#cafe\u0301', 'combining acute accent'],
    ['#日本', 'CJK only'],
    ['#abc日本', 'ASCII then CJK'],
    ['#tag١', 'ASCII then an Arabic-Indic digit'],
    ['#ok\uFE0F', 'variation selector (a mark)'],
  ])('leaves %s (%s) as plain text, never a shorter ASCII tag', (content) => {
    expect(tags(content)).toEqual([])
    expect(extractHashtags(content, 63)).toEqual([])
    expect(Array.from(content.matchAll(HASHTAG_PATTERN))).toEqual([])
  })

  it('ends a tag at punctuation, emoji, spaces and brackets', () => {
    expect(tags('#ok! #fine🙂 (#paren) #comma, #dot. "#quote" #end')).toEqual(['ok', 'fine', 'paren', 'comma', 'dot', 'quote', 'end'])
    expect(tags('#a#b ##c')).toEqual(['a', 'b', 'c'])
    expect(tags('#snake_case_2 #UPPER')).toEqual(['snake_case_2', 'upper'])
  })

  it('keeps the tags around a non-ASCII word', () => {
    expect(tags('#dash #café #news #日本 $BTC')).toEqual(['dash', 'news', 'btc_cashtag'])
  })

  it('applies the same rule to cashtags', () => {
    expect(extractCashtags('$DASH $DASHé $Ñu $BTC\u0301 $ETH🙂 ($XMR)', 61)).toEqual(['dash_cashtag', 'eth_cashtag', 'xmr_cashtag'])
    expect(Array.from('$café'.matchAll(CASHTAG_PATTERN))).toEqual([])
  })

  it('leaves links alone, and a non-ASCII tag after a link is still no tag', () => {
    expect(tags('https://example.com/#café #ok www.dash.org/#x ipfs://cid/$BTC')).toEqual(['ok'])
    expect(tags('see https://dash.org #naïve')).toEqual([])
  })

  it('matches links and both tag kinds in one pass, as the renderer does', () => {
    // A tag that starts before a link shadows it, so the tags inside it render (and index).
    expect(tags('#https://x.o/$abc')).toEqual(['https', 'abc_cashtag'])
    expect(tags('$www.x/#tag')).toEqual(['tag', 'www_cashtag'])
  })

  it('ignores the shared patterns\' lastIndex', () => {
    const pattern = HASHTAG_PATTERN
    pattern.lastIndex = 0
    expect(pattern.test('#zz #yy')).toBe(true)
    expect(extractAllTags('#ab', 61)).toEqual(['ab'])
    pattern.lastIndex = 0
  })
})

describe('tag length ceiling', () => {
  it('indexes a tag of exactly the ceiling and no longer one, never a prefix', () => {
    expect(indexedTags(`#${'a'.repeat(61)}`, 1, 61)).toEqual(['a'.repeat(61)])
    expect(indexedTags(`#${'a'.repeat(62)}`, 1, 61)).toEqual([])
    expect(indexedTags(`#${'a'.repeat(70)} #b`, 4, 61)).toEqual(['b'])
    expect(extractHashtags(`#${'a'.repeat(63)} #${'b'.repeat(64)}`, 63)).toEqual(['a'.repeat(63)])
  })

  it.each([61, 63])('counts the cashtag suffix against the %i-character ceiling', (maxLength) => {
    const fits = 'A'.repeat(maxLength - '_cashtag'.length)
    expect(indexedTags(`$${fits}`, 1, maxLength)).toEqual([fits.toLowerCase() + '_cashtag'])
    expect(indexedTags(`$${fits}B`, 1, maxLength)).toEqual([])
  })

  it('returns the storage form of a tag that fits, else null', () => {
    expect(tagStorage('#Dash', 61)).toBe('dash')
    expect(tagStorage('$DASH', 61)).toBe('dash_cashtag')
    expect(tagStorage(`#${'a'.repeat(61)}`, 61)).toBe('a'.repeat(61))
    expect(tagStorage(`#${'a'.repeat(62)}`, 61)).toBeNull()
    expect(tagStorage(`$${'A'.repeat(54)}`, 61)).toBeNull()
  })
})

describe('cashtags', () => {
  it('stores cashtags with a suffix so they share the hashtag index', () => {
    expect(extractCashtags('buy $DASH not $dash or $1bad', 63)).toEqual(['dash_cashtag'])
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
    expect(extractAllTags('#dash $DASH #dash', 63)).toEqual(['dash', 'dash_cashtag'])
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
    expect(indexedTags(`#${'a'.repeat(70)} $DASH`, 1, 61)).toEqual(['dash_cashtag'])
  })
})

describe('tag list (v16)', () => {
  it('indexes the hashtags in order, then the cashtags, distinct, up to the maximum', () => {
    expect(indexedTags('$DASH #News then #dash and #news, $btc', 4, 61)).toEqual(['news', 'dash', 'dash_cashtag', 'btc_cashtag'])
    expect(indexedTags('#a #b #c #d #e $DASH', 4, 61)).toEqual(['a', 'b', 'c', 'd'])
    expect(indexedTags('#a $DASH', 4, 61)).toEqual(['a', 'dash_cashtag'])
    expect(indexedTags('nothing to index, $1bad', 4, 61)).toEqual([])
  })

  it('counts no tag inside a link, as the post renders it (a fragment, a query)', () => {
    const text = 'gm #dash #news #btc #eth see https://docs.dash.org/en/stable/#install and https://x.com/search?q=$BTC'
    expect(indexedTags(text, Number.MAX_SAFE_INTEGER, 61)).toEqual(['dash', 'news', 'btc', 'eth'])
    expect(indexedTags('www.example.com/#a ipfs://cid/#b $ETH', 4, 61)).toEqual(['eth_cashtag'])
    expect(extractHashtags('#a https://x.org/#b #c', 63)).toEqual(['a', 'c'])
    expect(extractCashtags('$DASH https://x.org/?q=$BTC', 63)).toEqual(['dash_cashtag'])
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
