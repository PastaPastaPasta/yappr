import { beforeEach, describe, expect, it } from 'vitest'
import { fileSignInReturn, takeSignInReturn } from './sign-in-return'

const items = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  },
})

describe('the page a wallet sign-in returns to', () => {
  beforeEach(() => items.clear())

  it('is given back once, for the request it started with', () => {
    fileSignInReturn('aa', null, '/settings/?section=privateFeed#private-feed-requests')
    expect(takeSignInReturn('bb')).toBeNull()
    expect(takeSignInReturn('aa')).toBe('/settings/?section=privateFeed#private-feed-requests')
    expect(takeSignInReturn('aa')).toBeNull()
  })

  it('keeps nothing it would refuse to follow, even when storage was changed', () => {
    fileSignInReturn('aa', null, '//evil.example')
    expect(takeSignInReturn('aa')).toBeNull()
    items.set([...items.keys()][0] ?? 'yappr-app-connect-sign-in-return', JSON.stringify({ requestHash: 'aa', route: '//evil.example' }))
    expect(takeSignInReturn('aa')).toBeNull()
  })

  it('keeps the page a request was filed with when another page resumes it', () => {
    fileSignInReturn('aa', null, '/user/?id=x')
    fileSignInReturn('aa', null, '/feed/')
    expect(takeSignInReturn('aa')).toBe('/user/?id=x')
  })

  it('files a request that replaces another ("Check again") with the page of the one it replaces', () => {
    fileSignInReturn('aa', null, '/user/?id=x')
    fileSignInReturn('bb', 'aa', '/feed/')
    expect(takeSignInReturn('aa')).toBeNull()
    expect(takeSignInReturn('bb')).toBe('/user/?id=x')
  })

  it('files a new request with the page it starts from', () => {
    fileSignInReturn('aa', null, '/user/?id=x')
    fileSignInReturn('cc', null, '/search/?q=dash')
    expect(takeSignInReturn('cc')).toBe('/search/?q=dash')
  })
})
