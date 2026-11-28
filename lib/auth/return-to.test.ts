import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETURN_TO,
  afterRegistrationRoute,
  loginPageDestination,
  loginRoute,
  onLoginPage,
  returnToOrDefault,
  sanitizeReturnTo,
  signInReturnRoute,
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
      '/dpns/register', '/dpns/register/', '/dpns/register?next=%2Ffeed',
      '/login', '/login/?x=1',
      '/./dpns/register/', '/feed/../dpns/register/',
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
    expect(sanitizeReturnTo('/testing/dpns/register/', '/testing')).toBeNull()
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
    expect(returnToOrDefault('/dpns/register/', '')).toBe('/feed')
  })

  it('returns a safe value as is', () => {
    expect(returnToOrDefault('/messages/?conversation=x', '')).toBe('/messages/?conversation=x')
  })
})

describe('loginPageDestination', () => {
  it("prefers the page's own next, then the page a wallet sign-in carried, then the feed", () => {
    expect(loginPageDestination('/settings/', { returnTo: '/messages/' })).toBe('/settings/')
    expect(loginPageDestination(null, { returnTo: '/messages/' })).toBe('/messages/')
    expect(loginPageDestination('//evil.example', { returnTo: '/messages/' })).toBe('/messages/')
    expect(loginPageDestination(null, { returnTo: '//evil.example' })).toBe('/feed')
    expect(loginPageDestination(null, { returnTo: '/login/' })).toBe('/feed')
    expect(loginPageDestination(null, { returnTo: '/connect/?r=ab&ac=declined' })).toBe('/feed')
    expect(loginPageDestination(null)).toBe('/feed')
  })

  it('goes to the username step first when the sign-in started there, carrying its page', () => {
    expect(loginPageDestination(null, { returnTo: '/post?id=1#reply', registerUsername: true })).toBe('/dpns/register?next=%2Fpost%3Fid%3D1%23reply')
    expect(loginPageDestination(null, { registerUsername: true })).toBe('/dpns/register')
    expect(loginPageDestination(null, { returnTo: '//evil.example', registerUsername: true })).toBe('/dpns/register')
    expect(loginPageDestination('/settings/', { returnTo: '/messages/', registerUsername: true })).toBe('/settings/')
  })
})

describe('afterRegistrationRoute', () => {
  it('returns to next once a username was registered', () => {
    expect(afterRegistrationRoute(true, '/settings')).toBe('/settings')
  })

  it('goes to the feed when every registration failed, so a username-gated page is not revisited', () => {
    expect(afterRegistrationRoute(false, '/settings')).toBe(DEFAULT_RETURN_TO)
  })

  it('still refuses an unsafe next after a success', () => {
    expect(afterRegistrationRoute(true, '//evil.example')).toBe(DEFAULT_RETURN_TO)
  })
})

describe('fragments', () => {
  it('keeps one that decodes and drops one that does not, with the path and query', () => {
    expect(sanitizeReturnTo('/settings/?section=x#caf%C3%A9', '')).toBe('/settings/?section=x#caf%C3%A9')
    expect(sanitizeReturnTo('/settings/?section=x#%', '')).toBe('/settings/?section=x')
    expect(sanitizeReturnTo('/settings/?section=x#%FF', '')).toBe('/settings/?section=x')
  })
})

describe('loginRoute', () => {
  it('carries the page the visitor opened, without the deployment base path', () => {
    expect(loginRoute('/staging/messages/?conversation=x', '/staging')).toBe('/login?next=%2Fmessages%2F%3Fconversation%3Dx')
    expect(returnToOrDefault(decodeURIComponent(loginRoute('/messages/', '').split('next=')[1]), '')).toBe('/messages/')
  })

  it('carries nothing it would refuse to follow', () => {
    expect(loginRoute('/login/', '')).toBe('/login')
    expect(loginRoute('//evil.example', '')).toBe('/login')
  })
})

describe('where a sign-in started here returns to', () => {
  afterEach(() => vi.unstubAllGlobals())
  const at = (pathname: string, search = '', hash = '') => vi.stubGlobal('window', { location: { pathname, search, hash } })

  it('is this page, fragment included', () => {
    at('/settings/', '?section=privateFeed', '#private-feed-requests')
    expect(signInReturnRoute()).toBe('/settings/?section=privateFeed#private-feed-requests')
  })

  it('is the `next` a detour page carries', () => {
    at('/login/', '?next=%2Fmessages%2F')
    expect(signInReturnRoute()).toBe('/messages/')
    at('/login/', '?next=%2F%2Fevil.example')
    expect(signInReturnRoute()).toBeNull()
  })

  it('knows the sign-in page, under a base path too', () => {
    at('/staging/login/', '?next=%2Fmessages%2F')
    expect(onLoginPage()).toBe(true)
    at('/post/', '?id=x&next=%2Fmessages%2F')
    expect(onLoginPage()).toBe(false)
  })
})
