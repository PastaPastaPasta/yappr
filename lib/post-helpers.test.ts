import { describe, expect, it } from 'vitest'
import {
  cashtagDisplayToStorage,
  cashtagStorageToDisplay,
  extractAllTags,
  extractCashtags,
  extractHashtags,
  extractMentions,
  firstHashtag,
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

describe('mentions', () => {
  it('normalizes DPNS usernames', () => {
    expect(normalizeDpnsUsername('Pasta.dash')).toBe('pasta')
    expect(normalizeDpnsUsername('PASTA')).toBe('pasta')
  })

  it('extracts deduplicated mentions with or without .dash', () => {
    expect(extractMentions('hi @Alice.dash and @alice, cc @bob_2')).toEqual(['alice', 'bob_2'])
    expect(extractMentions('email me at foo@bar.com')).toEqual(['bar'])
  })
})
