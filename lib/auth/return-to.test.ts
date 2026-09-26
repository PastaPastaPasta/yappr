import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETURN_TO,
  RETURN_TO_PARAM,
  dpnsRegisterHref,
  profileCreateHref,
  returnToOrDefault,
  sanitizeReturnTo,
} from './return-to'

describe('sanitizeReturnTo', () => {
  it('accepts an app-relative path with its query and hash', () => {
    expect(sanitizeReturnTo('/feed/', '')).toBe('/feed/')
    expect(sanitizeReturnTo('/post/?id=abc123', '')).toBe('/post/?id=abc123')
    expect(sanitizeReturnTo('/user/?id=abc&tab=likes#top', '')).toBe('/user/?id=abc&tab=likes#top')
    expect(sanitizeReturnTo('/', '')).toBe('/')
  })

  it('rejects anything that could leave the app (open redirects)', () => {
    for (const value of [
      'https://evil.example/feed',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//evil.example/feed',
      '///evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      ' /feed',
      'feed/',
      '?id=1',
      '#top',
    ]) {
      expect(sanitizeReturnTo(value, '')).toBeNull()
    }
  })

  it('keeps a percent-encoded slash encoded, so it stays a same-origin path', () => {
    const result = sanitizeReturnTo('/%2F/evil.example', '')
    expect(result).toBe('/%2F/evil.example')
    expect(new URL(result ?? '', 'https://app.example').origin).toBe('https://app.example')
  })

  it('rejects empty, missing and oversized values', () => {
    expect(sanitizeReturnTo(null, '')).toBeNull()
    expect(sanitizeReturnTo(undefined, '')).toBeNull()
    expect(sanitizeReturnTo('', '')).toBeNull()
    expect(sanitizeReturnTo(`/post/?id=${'a'.repeat(3000)}`, '')).toBeNull()
  })

  it('never returns to the detour routes or /login', () => {
    for (const value of [
      '/profile/create', '/profile/create/', '/profile/create/?next=%2Ffeed',
      '/dpns/register/', '/dpns/register?next=%2Ffeed',
      '/login', '/login/?x=1',
      '/./profile/create/', '/feed/../profile/create/',
    ]) {
      expect(sanitizeReturnTo(value, '')).toBeNull()
    }
  })

  it('strips a leading basePath so router.push does not double it', () => {
    expect(sanitizeReturnTo('/testing/post/?id=1', '/testing')).toBe('/post/?id=1')
    expect(sanitizeReturnTo('/testing', '/testing')).toBe('/')
    expect(sanitizeReturnTo('/testing?x=1', '/testing')).toBe('/?x=1')
    expect(sanitizeReturnTo('/devnet/feed/', '/devnet/')).toBe('/feed/')
    expect(sanitizeReturnTo('/post/?id=1', '/testing')).toBe('/post/?id=1')
    // Only a whole segment is the basePath.
    expect(sanitizeReturnTo('/testingfoo/', '/testing')).toBe('/testingfoo/')
  })

  it('still refuses a blocked route or a protocol-relative path behind the basePath', () => {
    expect(sanitizeReturnTo('/testing/profile/create/', '/testing')).toBeNull()
    expect(sanitizeReturnTo('/testing/login/', '/testing')).toBeNull()
    expect(sanitizeReturnTo('/testing//evil.example', '/testing')).toBeNull()
  })
})

describe('returnToOrDefault', () => {
  it('falls back to the feed when the value is missing or unsafe', () => {
    expect(DEFAULT_RETURN_TO).toBe('/feed')
    expect(returnToOrDefault(null, '')).toBe('/feed')
    expect(returnToOrDefault('//evil.example', '')).toBe('/feed')
    expect(returnToOrDefault('https://evil.example', '')).toBe('/feed')
    expect(returnToOrDefault('/profile/create/', '')).toBe('/feed')
  })

  it('returns a safe value as is', () => {
    expect(returnToOrDefault('/messages/?conversation=x', '')).toBe('/messages/?conversation=x')
  })
})

describe('profileCreateHref and dpnsRegisterHref', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('encode the route into the next parameter so it round-trips', () => {
    const route = '/post/?id=abc&reply=1#r'
    const href = profileCreateHref(route)
    expect(href).toBe(`/profile/create?${RETURN_TO_PARAM}=${encodeURIComponent(route)}`)
    const next = new URL(href, 'https://app.example').searchParams.get(RETURN_TO_PARAM)
    expect(next).toBe(route)
    expect(returnToOrDefault(next, '')).toBe(route)

    expect(dpnsRegisterHref('/settings/?section=keys')).toBe('/dpns/register?next=%2Fsettings%2F%3Fsection%3Dkeys')
  })

  it('drop an unsafe or missing next instead of carrying it', () => {
    expect(profileCreateHref(undefined)).toBe('/profile/create')
    expect(profileCreateHref('//evil.example')).toBe('/profile/create')
    expect(profileCreateHref('/profile/create/')).toBe('/profile/create')
    expect(dpnsRegisterHref('/login/')).toBe('/dpns/register')
  })

  it('carry next through the DPNS step unchanged', () => {
    const route = '/user/?id=abc'
    const dpnsNext = new URL(dpnsRegisterHref(route), 'https://app.example').searchParams.get(RETURN_TO_PARAM)
    const profileNext = new URL(profileCreateHref(dpnsNext), 'https://app.example').searchParams.get(RETURN_TO_PARAM)
    expect(profileNext).toBe(route)
  })

  it('respect the deployment basePath', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/testing')
    expect(profileCreateHref('/testing/post/?id=1')).toBe('/profile/create?next=%2Fpost%2F%3Fid%3D1')
    expect(returnToOrDefault('/testing/feed/')).toBe('/feed/')
  })
})
