import { describe, expect, it } from 'vitest'
import { profileModerationReadStep } from './profile-moderation-read'

const base = { hidesProfiles: true, userId: 'alice', sdkReady: true, sdkError: null }

describe('profileModerationReadStep', () => {
  it('reads once the SDK is ready', () => {
    expect(profileModerationReadStep(base)).toBe('read')
  })

  it('waits, and reads nothing, while the SDK is not ready (a cold signed-out visit)', () => {
    expect(profileModerationReadStep({ ...base, sdkReady: false })).toEqual({ settle: 'pending' })
  })

  it('fails closed when the SDK could not start', () => {
    expect(profileModerationReadStep({ ...base, sdkReady: false, sdkError: 'offline' })).toEqual({ settle: 'failed' })
  })

  it('has nothing to read off a hide cut or without a profile id, ready or not', () => {
    expect(profileModerationReadStep({ ...base, hidesProfiles: false })).toEqual({ settle: 'done' })
    expect(profileModerationReadStep({ ...base, userId: null, sdkReady: false })).toEqual({ settle: 'done' })
  })
})
