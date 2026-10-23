import { describe, expect, it } from 'vitest'
import { CRITICAL_KEY_REQUIRED, CriticalKeyCancelledError } from '@/lib/auth/critical-key'
import { PENDING_WRITE_ERROR } from '@/lib/error-utils'
import { CharterActionError, charterActionError, isStatelessRefusal } from './refusals'

const refusal = (code: number, message = 'refused') => Object.assign(new Error(message), { code })

describe('refusals in plain words', () => {
  it('says what a refusal means for the action that hit it', () => {
    expect(charterActionError('application', refusal(40105)).message).toBe('This contract already has a seated team.')
    expect(charterActionError('join', refusal(40105)).message).toBe("You've already asked to join this team.")
    expect(charterActionError('reason', refusal(40105)).message).toMatch(/already have a reason with this code/)
    expect(charterActionError('application', refusal(40112)).message).toBe("You've already applied for this contract.")
    expect(charterActionError('application', refusal(40135)).message).toBe("Applications for this contract haven't opened yet.")
    expect(charterActionError('application', refusal(40120)).message).toMatch(/hasn't asked to join/)
    expect(charterActionError('add-member', refusal(41202)).message).toMatch(/as many members as the contract allows/)
    expect(charterActionError('join', refusal(40136)).message).toMatch(/leader has no charter key/)
  })

  it('reads a code a message carries, and covers balance, key and schema refusals for any action', () => {
    expect(charterActionError('proposal', new Error('Broadcast failed (code=10422)')).message).toBe('The reward split must add up to 100.')
    expect(charterActionError('join', refusal(40210)).message).toMatch(/balance is too low/)
    expect(charterActionError('proposal', refusal(20007)).message).toMatch(/CRITICAL or HIGH key/)
  })

  it('never shows a raw error', () => {
    const unknown = charterActionError('proposal', new Error('wasm panic at 0x1234: unreachable executed'))
    expect(unknown.message).toBe("That didn't go through. Please try again in a moment.")
    expect(charterActionError('proposal', refusal(49999, 'internal detail')).message).not.toMatch(/internal detail/)
  })

  it('tells an uncertain outcome from a refusal, and a closed key prompt from both', () => {
    expect(charterActionError('application', new Error('Request timed out after 30s'))).toMatchObject({ outcome: 'uncertain' })
    expect(charterActionError('application', new CriticalKeyCancelledError())).toMatchObject({ outcome: 'cancelled' })
    expect(charterActionError('application', new Error(CRITICAL_KEY_REQUIRED))).toMatchObject({ outcome: 'refused' })
    const kept = new CharterActionError('as is', 'refused', 1)
    expect(charterActionError('join', kept)).toBe(kept)
  })

  it('tells a leader taking a member off what an earlier pending write holds it back on', () => {
    expect(charterActionError('undo-team-change', new Error(PENDING_WRITE_ERROR)).message).toMatch(/Something you sent from this browser may still go through/)
    expect(charterActionError('proposal', new Error(PENDING_WRITE_ERROR)).message).toBe(PENDING_WRITE_ERROR)
  })
})

describe('stateless refusals', () => {
  it('reads any basic-structure or signature code as stateless on a first send, only schema codes on a resend, state codes never', () => {
    expect(isStatelessRefusal(refusal(10418), { fresh: true })).toBe(true)
    expect(isStatelessRefusal(refusal(20007), { fresh: true })).toBe(true)
    expect(isStatelessRefusal(new Error('Broadcast failed (code=10421)'), { fresh: false })).toBe(true)
    expect(isStatelessRefusal(refusal(10101), { fresh: false })).toBe(true)
    expect(isStatelessRefusal(refusal(10418), { fresh: false })).toBe(false)
    expect(isStatelessRefusal(refusal(20007), { fresh: false })).toBe(false)
    expect(isStatelessRefusal(refusal(30000), { fresh: true })).toBe(false)
    expect(isStatelessRefusal(refusal(40112), { fresh: true })).toBe(false)
    expect(isStatelessRefusal(new Error('Request timed out'), { fresh: true })).toBe(false)
  })
})
