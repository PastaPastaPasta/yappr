import { describe, expect, it } from 'vitest'
import { getSocialLinkUrl } from './profile-links'
import { validateSocialHandle } from './social-link-validation'

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
