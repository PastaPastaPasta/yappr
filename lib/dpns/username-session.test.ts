import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubBrowserStorage } from '../test-storage'
import { hasSkippedUsername } from '../username-skip'
import { grantedUsername, recordRegistration, senderStillActive } from './username-session'

function session(identityId: string | null, epoch = 1) {
  const state = { identityId, epoch }
  return {
    state,
    sessionEpoch: () => state.epoch,
    getState: () => ({ user: state.identityId ? { identityId: state.identityId } : null }),
  }
}

const voteOnly = [{ label: 'abc', success: true, isContested: true }]

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const alice = { identityId: 'alice', epoch: 1, username: null }

describe('recordRegistration', () => {
  it('never makes a name that only joined its vote the username, and lets the user go on without one', () => {
    expect(recordRegistration(voteOnly, alice)).toBeNull()
    expect(hasSkippedUsername('alice')).toBe(true)
  })

  it('keeps that outcome through Register more and a failed second batch', () => {
    recordRegistration(voteOnly, alice)
    expect(recordRegistration([{ label: 'xyz', success: false, isContested: true }], alice)).toBeNull()
    expect(hasSkippedUsername('alice')).toBe(true)
  })

  it('grants a free name, and a contender never replaces a name the user has', () => {
    expect(recordRegistration(
      [{ label: 'abc', success: true, isContested: true }, { label: 'usable-name-27', success: true, isContested: false }],
      alice
    )).toBe('usable-name-27')
    expect(recordRegistration(voteOnly, { ...alice, username: 'usable-name-27' })).toBeNull()
    expect(hasSkippedUsername('alice')).toBe(false)
  })

  it('does not let the user skip a username after a failed batch', () => {
    recordRegistration([{ label: 'abc', success: false, isContested: true }], alice)
    expect(hasSkippedUsername('alice')).toBe(false)
  })
})

describe('senderStillActive', () => {
  it('holds only while the sending session is the active one', () => {
    expect(senderStillActive(alice, session('alice'))).toBe(true)
    expect(senderStillActive(alice, session(null, 2))).toBe(false)
    expect(senderStillActive(alice, session('bob', 3))).toBe(false)
    expect(senderStillActive(alice, session('alice', 3))).toBe(false)
  })
})

describe('grantedUsername', () => {
  it('takes the first non-contested success', () => {
    expect(grantedUsername(voteOnly)).toBeNull()
    expect(grantedUsername([{ label: 'x', success: false, isContested: false }, { label: 'y', success: true, isContested: false }])).toBe('y')
  })
})
