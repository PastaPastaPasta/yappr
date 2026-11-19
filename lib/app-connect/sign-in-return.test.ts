import { beforeEach, describe, expect, it } from 'vitest'
import { rememberSignInReturn, takeSignInReturn } from './sign-in-return'

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
    rememberSignInReturn('aa', '/settings/?section=privateFeed#private-feed-requests')
    expect(takeSignInReturn('bb')).toBeNull()
    expect(takeSignInReturn('aa')).toBe('/settings/?section=privateFeed#private-feed-requests')
    expect(takeSignInReturn('aa')).toBeNull()
  })

  it('keeps nothing it would refuse to follow, even when storage was changed', () => {
    rememberSignInReturn('aa', '//evil.example')
    expect(takeSignInReturn('aa')).toBeNull()
    items.set([...items.keys()][0] ?? 'yappr-app-connect-sign-in-return', JSON.stringify({ requestHash: 'aa', route: '//evil.example' }))
    expect(takeSignInReturn('aa')).toBeNull()
  })
})
