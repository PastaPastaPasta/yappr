// Imports the TypeScript module directly: needs Node 22.18+ or 23.6+ (type stripping on by default), or --experimental-strip-types from 22.6.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantedUsername, needsUsernameSetup, recordRegistration } from '../lib/dpns/username-session.ts'

const SKIP = 'yappr_skip_dpns'

function sessionStore() {
  const items = new Map()
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)) } }
}

test('a vote-only success, Register More, a failed retry, then Continue: no redirect to username setup', () => {
  const session = sessionStore()
  let username = null
  // First batch: the user's only name joins its vote.
  username = recordRegistration([{ label: 'abc', success: true, isContested: true }], username, session, SKIP) ?? username
  // Register More resets the wizard's rows; the session is untouched. The second attempt fails.
  username = recordRegistration([{ label: 'xyz', success: false, isContested: true }], username, session, SKIP) ?? username
  // Continue does nothing more. Settings and Messages are plain withAuth pages.
  assert.equal(username, null)
  assert.equal(needsUsernameSetup({ dpnsUsername: username }, undefined, session, SKIP), false)
})

test('without a vote-only success, a user with no name is still sent to username setup', () => {
  const session = sessionStore()
  recordRegistration([{ label: 'xyz', success: false, isContested: true }], null, session, SKIP)
  assert.equal(needsUsernameSetup({ dpnsUsername: null }, undefined, session, SKIP), true)
  assert.equal(needsUsernameSetup({ dpnsUsername: null }, { allowWithoutDPNS: true }, session, SKIP), false)
})

test('a granted name is saved, and a contender never replaces it', () => {
  const session = sessionStore()
  let username = null
  username = recordRegistration([{ label: 'usable-name-27', success: true, isContested: false }], username, session, SKIP) ?? username
  username = recordRegistration([{ label: 'abc', success: true, isContested: true }], username, session, SKIP) ?? username
  assert.equal(username, 'usable-name-27')
  assert.equal(session.getItem(SKIP), null)
  assert.equal(grantedUsername([{ label: 'abc', success: true, isContested: true }, { label: 'usable-name-28', success: true, isContested: false }]), 'usable-name-28')
})
