import { describe, expect, it } from 'vitest'
import { getSocialLinkUrl } from './profile-links'
import { socialLinkAddProblem, validateSocialHandle } from './social-link-validation'

describe('social handle validation', () => {
  it.each([
    ['github', 'yappr-qa53', 'https://github.com/yappr-qa53'],
    ['github', ' @qa-persona-53 ', 'https://github.com/qa-persona-53'],
    ['instagram', 'qa.persona53', 'https://instagram.com/qa.persona53'],
    ['instagram', '@qa.persona_53', 'https://instagram.com/qa.persona_53'],
  ])('accepts a valid %s handle and preserves its destination', (platform, handle, url) => {
    expect(validateSocialHandle(platform, handle)).toBeNull()
    expect(getSocialLinkUrl(platform, handle)).toBe(url)
  })

  it.each(['qa_persona', '-qa', 'qa-', 'qa--persona', 'qa.persona', 'qa/persona'])('rejects invalid GitHub username %s', (handle) => {
    expect(validateSocialHandle('github', handle)).not.toBeNull()
  })

  it.each(['qa-persona', 'qa persona', 'qa/persona', 'qa@persona'])('rejects unsupported Instagram characters in %s', (handle) => {
    expect(validateSocialHandle('instagram', handle)).not.toBeNull()
  })

  it.each(['twitter', 'telegram', 'twitch'])('preserves %s validation', (platform) => {
    expect(validateSocialHandle(platform, '@qa_persona53')).toBeNull()
    expect(validateSocialHandle(platform, 'qa-persona53')).not.toBeNull()
    expect(validateSocialHandle(platform, 'qa.persona53')).not.toBeNull()
  })
})

describe('adding a social link', () => {
  it('counts UTF-8 bytes, not characters, against the 256-byte contract limit', () => {
    // 200 characters but 400 bytes; the stored "other:" string is 406 bytes.
    expect(socialLinkAddProblem([], { platform: 'other', handle: 'é'.repeat(200) }, 'Other')).toMatch(/at most 250 bytes/)
    expect(socialLinkAddProblem([], { platform: 'other', handle: 'é'.repeat(125) }, 'Other')).toBeNull()
    expect(socialLinkAddProblem([], { platform: 'other', handle: 'x'.repeat(250) }, 'Other')).toBeNull()
    expect(socialLinkAddProblem([], { platform: 'other', handle: 'é'.repeat(126) }, 'Other')).not.toBeNull()
  })

  it('refuses a link that is already in the list', () => {
    const existing = [{ platform: 'github', handle: 'sigrid-qa' }]
    expect(socialLinkAddProblem(existing, { platform: 'github', handle: 'sigrid-qa' }, 'GitHub')).toBe('This link is already added')
    expect(socialLinkAddProblem(existing, { platform: 'twitter', handle: 'sigrid-qa' }, 'Twitter/X')).toBeNull()
  })
})
