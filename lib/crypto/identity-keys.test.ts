import { describe, expect, it } from 'vitest'
import { KeyPurpose, wrongPurposeLoginMessage } from './identity-keys'

describe('wrongPurposeLoginMessage', () => {
  it('names the purpose in words, with its article', () => {
    expect(wrongPurposeLoginMessage(KeyPurpose.ENCRYPTION)).toBe('This is an encryption key. Sign in with an authentication key instead.')
    expect(wrongPurposeLoginMessage(KeyPurpose.OWNER)).toBe('This is an owner key. Sign in with an authentication key instead.')
    expect(wrongPurposeLoginMessage(KeyPurpose.TRANSFER)).toBe('This is a transfer key. Sign in with an authentication key instead.')
  })

  it('does not invent a name for a purpose it does not know', () => {
    expect(wrongPurposeLoginMessage(42)).toBe('This key cannot sign in. Sign in with an authentication key instead.')
  })
})
