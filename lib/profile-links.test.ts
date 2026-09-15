import { describe, expect, it } from 'vitest'
import { getSocialLinkUrl, isValidHttpUrl } from './profile-links'

describe('getSocialLinkUrl', () => {
  it.each([
    ['twitter', '@alice', 'https://x.com/alice'],
    ['github', 'alice', 'https://github.com/alice'],
    ['telegram', 'alice', 'https://t.me/alice'],
    ['youtube', '@alice', 'https://www.youtube.com/@alice'],
    ['twitch', 'alice', 'https://twitch.tv/alice'],
    ['instagram', 'alice', 'https://instagram.com/alice'],
    ['linkedin', 'alice', 'https://linkedin.com/in/alice'],
    ['email', 'a@b.co', 'mailto:a%40b.co'],
    ['mastodon', '@alice@mas.to', 'https://mas.to/@alice'],
    ['other', 'https://alice.example/x', 'https://alice.example/x'],
  ])('%s %s -> %s', (platform, handle, url) => {
    expect(getSocialLinkUrl(platform, handle)).toBe(url)
  })

  it('refuses handles that cannot be linked', () => {
    expect(getSocialLinkUrl('twitter', '  ')).toBeNull()
    expect(getSocialLinkUrl('youtube', '@')).toBeNull()
    expect(getSocialLinkUrl('email', 'not-an-email')).toBeNull()
    expect(getSocialLinkUrl('mastodon', 'alice')).toBeNull()
    expect(getSocialLinkUrl('other', 'javascript:alert(1)')).toBeNull()
    expect(getSocialLinkUrl('other', 'ftp://x')).toBeNull()
    expect(getSocialLinkUrl('unknown', 'alice')).toBeNull()
  })

  it('URL-encodes handles', () => {
    expect(getSocialLinkUrl('github', 'a/b?c')).toBe('https://github.com/a%2Fb%3Fc')
  })
})

describe('isValidHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isValidHttpUrl('https://a.test')).toBe(true)
    expect(isValidHttpUrl('http://a.test/x?y')).toBe(true)
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isValidHttpUrl('a.test')).toBe(false)
  })
})
