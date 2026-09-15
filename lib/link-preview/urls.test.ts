import { describe, expect, it } from 'vitest'
import {
  extractFirstUrl,
  extractYapprPostId,
  extractYouTubeVideoId,
  isDirectImageUrl,
  shouldSkipPreview,
  stripTrailingPunctuation,
} from './urls'

describe('extractYouTubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc123', 'abc123'],
    ['https://youtu.be/abc123', 'abc123'],
    ['https://youtu.be/abc123?t=10', 'abc123'],
    ['https://m.youtube.com/watch?v=abc123&list=x', 'abc123'],
    ['https://www.youtube.com/embed/abc123', 'abc123'],
    ['https://www.youtube.com/shorts/abc123', 'abc123'],
    ['https://www.youtube.com/live/abc123?feature=share', 'abc123'],
  ])('%s -> %s', (url, id) => {
    expect(extractYouTubeVideoId(url)).toBe(id)
  })

  it('rejects non-YouTube hosts and look-alikes', () => {
    expect(extractYouTubeVideoId('https://example.com/watch?v=abc')).toBeNull()
    expect(extractYouTubeVideoId('https://notyoutube.com/watch?v=abc')).toBeNull()
    expect(extractYouTubeVideoId('https://www.youtube.com/')).toBeNull()
    expect(extractYouTubeVideoId('not a url')).toBeNull()
  })
})

describe('extractYapprPostId', () => {
  it('reads the query form on the production hosts', () => {
    expect(extractYapprPostId('https://yap.pr/post/?id=P1')).toBe('P1')
    expect(extractYapprPostId('https://www.yap.pr/post?id=P1')).toBe('P1')
  })

  it('falls back to the path form', () => {
    expect(extractYapprPostId('https://yap.pr/post/P1')).toBe('P1')
  })

  it('accepts the current origin and rejects others', () => {
    expect(extractYapprPostId('https://staging.example/post/?id=P1', 'https://staging.example')).toBe('P1')
    expect(extractYapprPostId('https://elsewhere.example/post/?id=P1', 'https://staging.example')).toBeNull()
    expect(extractYapprPostId('https://yap.pr/user?id=U1')).toBeNull()
  })
})

describe('isDirectImageUrl', () => {
  it('matches by extension only', () => {
    expect(isDirectImageUrl('https://x.test/a.PNG')).toBe(true)
    expect(isDirectImageUrl('https://x.test/a.png?w=1')).toBe(true)
    expect(isDirectImageUrl('https://x.test/a.html')).toBe(false)
    expect(isDirectImageUrl('nope')).toBe(false)
  })
})

describe('shouldSkipPreview', () => {
  it('skips local hosts and garbage, never ipfs://', () => {
    expect(shouldSkipPreview('http://localhost:3000/x')).toBe(true)
    expect(shouldSkipPreview('http://127.0.0.1/x')).toBe(true)
    expect(shouldSkipPreview('garbage')).toBe(true)
    expect(shouldSkipPreview('https://example.com')).toBe(false)
    expect(shouldSkipPreview('ipfs://bafy')).toBe(false)
  })
})

describe('stripTrailingPunctuation', () => {
  it('strips sentence punctuation but keeps balanced parentheses', () => {
    expect(stripTrailingPunctuation('https://a.test/x.')).toBe('https://a.test/x')
    expect(stripTrailingPunctuation('https://a.test/x?!')).toBe('https://a.test/x')
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(stripTrailingPunctuation('https://a.test/x).')).toBe('https://a.test/x')
  })
})

describe('extractFirstUrl', () => {
  it('finds http, ipfs and www links and cleans them', () => {
    expect(extractFirstUrl('see https://a.test/x, then more')).toBe('https://a.test/x')
    expect(extractFirstUrl('pinned at ipfs://bafy/img.png!')).toBe('ipfs://bafy/img.png')
    expect(extractFirstUrl('go to www.example.com.')).toBe('https://www.example.com')
    expect(extractFirstUrl('no links here')).toBeNull()
  })
})
