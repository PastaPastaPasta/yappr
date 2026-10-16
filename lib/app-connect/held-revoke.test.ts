import { describe, expect, it } from 'vitest'
import { settleHeldRevoke } from './held-revoke'

const held = { identityId: 'alice', epoch: 4 }

describe('settleHeldRevoke', () => {
  it('waits while the renewal for that identity is under way', () => {
    expect(settleHeldRevoke(held, null, 'alice', 4)).toBe('wait')
    expect(settleHeldRevoke(held, 'alice', 'alice', 4)).toBe('wait')
  })

  it('owes the sign-out once that renewal ends on the same session', () => {
    expect(settleHeldRevoke(held, 'alice', null, 4)).toBe('sign-out')
  })

  it('is dropped when a typed-key sign-in or a sign-out replaced the session meanwhile', () => {
    // The raw-key takeover of the same identity: its session must not be signed out by the old revoke.
    expect(settleHeldRevoke(held, 'alice', null, 5)).toBe('drop')
  })
})
