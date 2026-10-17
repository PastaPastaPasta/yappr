import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubBrowserStorage } from './test-storage'
import { hasSkippedUsername, rememberUsernameSkip } from './username-skip'

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('username skip', () => {
  it('is remembered per identity and persists in localStorage', () => {
    expect(hasSkippedUsername('alice')).toBe(false)
    rememberUsernameSkip('alice')
    expect(hasSkippedUsername('alice')).toBe(true)
    expect(hasSkippedUsername('bob')).toBe(false)
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(1)
  })

  it('reads as not skipped where storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(hasSkippedUsername('alice')).toBe(false)
  })
})
