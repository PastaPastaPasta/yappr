import { describe, expect, it } from 'vitest'
import { CRITICAL_KEY_REQUIRED, CriticalKeyCancelledError } from '@/lib/auth/critical-key'
import { CharterActionError, charterActionError } from './refusals'

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
})
