import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubBrowserStorage } from '../test-storage'
import { rememberUsernameSkip } from '../username-skip'
import { signInDestination } from './intent-destination'

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signInDestination', () => {
  it('asks an unnamed identity for a username', () => {
    expect(signInDestination({ kind: 'username-required', identityId: 'alice' })).toEqual({
      kind: 'username-prompt',
      identityId: 'alice',
    })
  })

  it('skip, sign out, sign in again: stays without asking', () => {
    rememberUsernameSkip('alice')
    // Sign-out keeps the choice (it belongs to the identity, not the session).
    sessionStorage.clear()
    expect(signInDestination({ kind: 'username-required', identityId: 'alice' })).toEqual({ kind: 'stay' })
    // Another identity on the same browser is still asked.
    expect(signInDestination({ kind: 'username-required', identityId: 'bob' }).kind).toBe('username-prompt')
  })

  it('keeps a ready session on its page and sends a signed-out one to sign in', () => {
    expect(signInDestination({ kind: 'ready', identityId: 'alice' })).toEqual({ kind: 'stay' })
    expect(signInDestination({ kind: 'profile-required', identityId: 'alice' })).toEqual({ kind: 'stay' })
    expect(signInDestination({ kind: 'logged-out' })).toEqual({ kind: 'route', href: '/login' })
  })
})
